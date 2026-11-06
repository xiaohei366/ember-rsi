import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createBundleSdk } from 'agent-bundle-core';
import { stringify } from 'yaml';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('..', import.meta.url));
const templates = join(project, 'examples/skill-development/gepa');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ignored = new Set(['.git', 'node_modules', '.rsi', '.scratch', 'dist']);

function within(root, target) {
  const path = relative(root, target);
  if (
    !path ||
    path === '..' ||
    path.startsWith(`..${sep}`) ||
    resolve(root, path) !== target
  )
    throw new Error(`Output must be a new descendant of ${root}`);
  return target;
}

async function inventory(root, copyTo) {
  const files = [];
  async function visit(directory, prefix = '') {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const source = join(directory, entry.name);
      const stat = await lstat(source);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error(`Prepared inputs require ordinary files: ${source}`);
      if (stat.isDirectory()) await visit(source, path);
      else {
        const bytes = await readFile(source);
        files.push({ path, sha256: sha256(bytes) });
        if (copyTo) {
          const destination = join(copyTo, path);
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, bytes, {
            flag: 'wx',
            mode: stat.mode & 0o777,
          });
        }
      }
    }
  }
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Input must be a real directory: ${root}`);
  await visit(root);
  return files;
}

async function verifyDevelopmentImage(image, lockSha256) {
  await execute('docker', ['image', 'inspect', image], {
    windowsHide: true,
    maxBuffer: 1_000_000,
  });
  const program = `
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    const cp = require('node:child_process');
    if (process.versions.node.split('.')[0] !== '24') throw Error('Development image requires Node 24');
    const pnpm = cp.execFileSync('pnpm', ['--version'], {encoding:'utf8'}).trim();
    if (pnpm !== '11.22.0') throw Error('Development image requires pnpm 11.22.0');
    if (!fs.statSync('/opt/ember-rsi-deps/node_modules').isDirectory()) throw Error('Offline dependencies missing');
    const lock = crypto.createHash('sha256').update(fs.readFileSync('/opt/ember-rsi-deps/pnpm-lock.yaml')).digest('hex');
    if (lock !== ${JSON.stringify(lockSha256)}) throw Error('Development image lockfile differs from frozen baseline');
    console.log(JSON.stringify({node:process.versions.node,pnpm,lockSha256:lock}));
  `;
  const result = await execute(
    'docker',
    [
      'run',
      '--rm',
      '--pull=never',
      '--network=none',
      '--entrypoint',
      'node',
      image,
      '-e',
      program,
    ],
    {
      windowsHide: true,
      maxBuffer: 1_000_000,
    },
  );
  return JSON.parse(result.stdout.trim());
}

/** Prepare inputs only; preflight, development, formal acceptance and review are separate executions. */
export async function prepareGepaDevelopment(options, dependencies = {}) {
  const repository = await realpath(resolve(options.repository ?? project));
  const model = options.model ?? 'ds-v4.1-flash';
  if (typeof model !== 'string' || !model.trim() || /[\r\n\0]/.test(model))
    throw new Error('--model must be a nonempty provider model identifier');
  if (!/^[^\s]+@sha256:[a-f0-9]{64}$/i.test(options.image ?? ''))
    throw new Error(
      '--image must identify an already prepared image by an immutable @sha256 digest',
    );
  if (!options.paper || !options.officeBundle)
    throw new Error('--paper and --office-bundle are required');
  const paper = await readFile(resolve(options.paper));
  if (paper.subarray(0, 5).toString() !== '%PDF-')
    throw new Error('--paper must be a local PDF of GEPA v2');
  const revision = (
    await execute(
      'git',
      [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${options.revision ?? 'HEAD'}^{commit}`,
      ],
      { cwd: repository, windowsHide: true },
    )
  ).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error('Unable to freeze a Git commit');
  const lock = (
    await execute('git', ['show', `${revision}:pnpm-lock.yaml`], {
      cwd: repository,
      windowsHide: true,
      encoding: 'buffer',
      maxBuffer: 16_000_000,
    })
  ).stdout;
  const imageVerification = await (
    dependencies.verifyImage ?? verifyDevelopmentImage
  )(options.image, sha256(lock));
  const dataRoot = resolve(repository, '.rsi');
  await mkdir(dataRoot, { recursive: true });
  if ((await lstat(dataRoot)).isSymbolicLink())
    throw new Error('.rsi cannot be a symbolic link');
  const requestedOutput = resolve(
    options.output ??
      join(
        dataRoot,
        `gepa-development-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      ),
  );
  // Resolve existing junctions before creating or mutating the owned output tree.
  const resolvedParent = await realpath(dirname(requestedOutput));
  const output = within(
    dataRoot,
    join(resolvedParent, basename(requestedOutput)),
  );
  // An exclusive new output directory prevents accidental reuse of earlier attempts.
  await mkdir(output);
  const baseline = join(output, 'baseline');
  const taskPackage = join(output, 'tasks');
  const task = join(taskPackage, 'gepa-development');
  const bundleTemplate = join(output, 'development-template');
  const bundle = join(output, 'skill-baseline');
  await mkdir(baseline);
  const archive = join(output, 'baseline.tar');
  await execute(
    'git',
    ['archive', '--format=tar', '--output', archive, revision],
    { cwd: repository, windowsHide: true },
  );
  const tracked = (
    await execute('git', ['ls-tree', '-r', revision], {
      cwd: repository,
      windowsHide: true,
      maxBuffer: 16_000_000,
    })
  ).stdout;
  if (tracked.split(/\r?\n/).some((line) => /^(?:120000|160000) /.test(line)))
    throw new Error(
      'Frozen baseline cannot contain symbolic links or submodules',
    );
  await execute('tar', ['-xf', archive, '-C', baseline], { windowsHide: true });
  const omittedSkill = within(baseline, resolve(baseline, 'skills/ember-rsi'));
  await rm(omittedSkill, { recursive: true, force: true });
  await rm(archive);
  const officeBundle = await realpath(resolve(options.officeBundle));
  const officeInput = join(baseline, '.gepa/input/office-bundle');
  await inventory(officeBundle, officeInput);
  await createBundleSdk().verify(officeInput);
  if (
    !(
      await lstat(
        join(officeInput, 'plugins/office-base/prompts/office-discipline.md'),
      )
    ).isFile()
  )
    throw new Error(
      'Office Bundle does not contain the agreed optimization prompt',
    );
  await writeFile(
    join(baseline, '.gepa/input/office-target.yaml'),
    await readFile(join(templates, 'targets/office.yaml')),
    { flag: 'wx' },
  );
  await inventory(join(templates, 'development-bundle'), bundleTemplate);
  await inventory(bundleTemplate, bundle);
  const skill = await realpath(
    resolve(options.skill ?? join(repository, 'skills/ember-rsi')),
  );
  await readFile(join(skill, 'SKILL.md'), 'utf8');
  const skillFiles = await inventory(skill, join(bundle, 'skills/ember-rsi'));
  await createBundleSdk().verify(bundle);
  await inventory(join(templates, 'task'), task);
  for (const path of [
    'instruction.md',
    'environment/materials/requirements.md',
  ]) {
    const file = join(task, path);
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replaceAll('ds-v4.1-flash', model),
    );
  }
  await inventory(baseline, join(task, 'environment/repository'));
  const dockerfile = join(task, 'environment/Dockerfile');
  await writeFile(
    dockerfile,
    (await readFile(dockerfile, 'utf8')).replace(
      '__DEVELOPMENT_IMAGE__',
      options.image,
    ),
  );
  await writeFile(join(task, 'environment/materials/gepa-v2.pdf'), paper, {
    flag: 'wx',
  });
  await writeFile(
    join(output, 'skill-target.yaml'),
    await readFile(join(templates, 'targets/skill.yaml')),
    { flag: 'wx' },
  );
  const services = {
    default: {
      model,
      base_url: '${MODEL_ENDPOINT}',
      api_key: '${MODEL_API_KEY}',
    },
  };
  const development = {
    sdk: {
      services,
      environment: 'docker',
      benchmark: {
        name: 'harbor',
        solver: { name: 'agentbundle' },
        config: {
          dataset: 'gepa-development',
          source: { kind: 'local', path: taskPackage },
          tasks: {
            root: '.',
            id: 'task.name',
            expectedCount: 1,
            requireTestScript: true,
          },
          defaults: {
            workdir: '/workspace/repository',
            buildTimeoutSeconds: 600,
          },
          scoring: { primary: 'reward', passThreshold: 1 },
        },
      },
    },
    taskId: 'gepa-development',
    taskPackage,
    baselineDirectory: baseline,
    taskDirectory: 'gepa-development',
    bundle: bundleTemplate,
    skillPrompt: 'plugins/development/prompts/development.md',
    deliveryDirectory: 'payload/0',
  };
  const recipe = {
    schemaVersion: 'rsi.recipe/v1',
    id: 'gepa-skill-development',
    application: {
      plugin: 'application.agentbundle',
      config: {
        target: { schema: join(output, 'skill-target.yaml') },
        baseline: { directory: bundle },
      },
    },
    policy: { id: 'policy.skill-development', config: { maxRounds: 10 } },
    bindings: {
      agent: {
        plugin: 'agent.pi',
        config: {
          model,
          base_url: '${MODEL_ENDPOINT}',
          api_key: '${MODEL_API_KEY}',
        },
      },
      evaluator: {
        plugin: 'evaluator.development',
        config: {
          development,
          preflight: {
            sdk: {
              services,
              environment: 'docker',
              benchmark: {
                name: 'workbuddy',
                scenario: 'office',
                solver: { name: 'agentbundle' },
              },
            },
            bundle: officeInput,
          },
          acceptance: {
            recipePath: '.gepa/recipe.yaml',
            pluginDirectory: '.gepa/extension',
          },
          developmentTimeoutMs: 3_600_000,
          acceptanceTimeoutMs: 14_400_000,
        },
      },
      proposer: { plugin: 'proposer.skill', config: { agentRef: 'agent' } },
      reviewer: {
        plugin: 'human.review',
        config: { waitTimeoutMs: 86_400_000 },
      },
    },
    budget: { elapsedWallMs: 259_200_000 },
  };
  await writeFile(
    join(output, 'recipe.yaml'),
    stringify(recipe, { aliasDuplicateObjects: false }),
    {
      flag: 'wx',
    },
  );
  const manifest = {
    schemaVersion: 'rsi.gepa-preparation/v1',
    status: 'prepared-inputs',
    repositoryRevision: revision,
    image: options.image,
    imageVerification,
    baselineTransformations: {
      omitted: ['skills/ember-rsi'],
      added: ['.gepa/input/office-bundle', '.gepa/input/office-target.yaml'],
    },
    paper: {
      reference: 'https://arxiv.org/abs/2507.19457v2',
      sha256: sha256(paper),
      identity: 'operator-supplied; verify v2 before execution',
    },
    skillFiles,
    baselineFiles: await inventory(baseline),
    taskFiles: await inventory(task),
    roleModels: {
      development: model,
      proposer: model,
      workbuddy: model,
      innerProposal: model,
    },
    recipe: join(output, 'recipe.yaml'),
    pluginDirectory: join(project, 'dist/src/extensions/skill-development'),
    verification: {
      preflight: 'not-run',
      development: 'not-run',
      acceptance: 'not-run',
      humanReview: 'not-requested',
    },
  };
  await writeFile(
    join(output, 'prepared.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: 'wx' },
  );
  return {
    output,
    recipe: manifest.recipe,
    pluginDirectory: manifest.pluginDirectory,
  };
}

function argumentsFrom(argv) {
  const names = {
    '--repository': 'repository',
    '--revision': 'revision',
    '--output': 'output',
    '--image': 'image',
    '--paper': 'paper',
    '--office-bundle': 'officeBundle',
    '--skill': 'skill',
    '--model': 'model',
  };
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = names[argv[index]];
    if (!key || !argv[index + 1] || argv[index + 1].startsWith('--'))
      throw new Error(`Unknown or incomplete option: ${argv[index]}`);
    if (Object.hasOwn(options, key))
      throw new Error(`Repeated option: ${argv[index]}`);
    options[key] = argv[++index];
  }
  return options;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.includes('--help')) {
    process.stdout.write(
      'Usage: node scripts/prepare-gepa-development.mjs --image NAME@sha256:DIGEST --paper GEPA_V2.pdf --office-bundle DIRECTORY [--model PROVIDER_MODEL_ID] [--repository DIRECTORY] [--revision COMMIT] [--skill DIRECTORY] [--output NEW_DIRECTORY_UNDER_REPOSITORY/.rsi]\n',
    );
  } else {
    try {
      process.stdout.write(
        `${JSON.stringify(await prepareGepaDevelopment(argumentsFrom(process.argv.slice(2))), null, 2)}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
