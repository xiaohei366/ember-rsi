import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { createBundleSdk } from 'agent-bundle-core';
import { parseHarborConfig, loadGenericHarborTask } from 'ember-evaluator';
import { prepareGepaDevelopment } from '../../scripts/prepare-gepa-development.mjs';

const execute = promisify(execFile);
const image = `fixture/development@sha256:${'1'.repeat(64)}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gepa-preparation-'));
  const repository = join(root, 'repository');
  const skill = join(root, 'skill');
  const officeBundle = join(root, 'office');
  const paper = join(root, 'paper.pdf');
  async function file(path, content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await file(
    join(repository, 'src/runtime/fixed.ts'),
    'export const fixed = true;\n',
  );
  await file(join(repository, '.gitattributes'), '* text eol=lf\n');
  await file(join(repository, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await file(
    join(repository, 'skills/ember-rsi/SKILL.md'),
    'Stale repository copy\n',
  );
  await file(
    join(skill, 'SKILL.md'),
    '---\nname: ember-rsi\ndescription: Fixture RSI development guidance\n---\nCurrent authoritative skill.\n',
  );
  await file(join(skill, 'references/guide.md'), 'Fixed reference.\n');
  await file(join(skill, 'assets/example.mjs'), 'export const fixed = true;\n');
  await file(
    join(officeBundle, 'bundle.yaml'),
    `schemaVersion: 1\nname: fixture-office\nkind: dsh-agent-bundle\nharness: { name: dsh, version: '>=0.1.6-alpha.1 <0.2' }\nplugins:\n  - path: plugins/office-base\nentry: agent.yaml\nlockfile: dependencies.lock\n`,
  );
  await file(join(officeBundle, 'agent.yaml'), 'plugins: {office-base: {}}\n');
  await file(
    join(officeBundle, 'dependencies.lock'),
    'bundle: fixture-office\nplugins:\n  - name: "@fixture/office"\n    version: 0.1.0\n    source: ./plugins/office-base\n',
  );
  await file(
    join(officeBundle, 'plugins/office-base/package.json'),
    JSON.stringify({
      name: '@fixture/office',
      version: '0.1.0',
      type: 'module',
      main: 'index.js',
      exports: { '.': './index.js' },
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }),
  );
  await file(
    join(officeBundle, 'plugins/office-base/index.js'),
    'export const name = "office-base"; export function apply() {}\n',
  );
  await file(
    join(officeBundle, 'plugins/office-base/cordis.patch.yml'),
    '- insert:\n    - id: office-base\n      name: "@fixture/office"\n',
  );
  await file(
    join(officeBundle, 'plugins/office-base/prompts/office-discipline.md'),
    'Fixed Office prompt.\n',
  );
  await writeFile(
    paper,
    '%PDF-fixture; paper identity deliberately not authenticated by preparation\n',
  );
  await execute('git', ['init'], { cwd: repository, windowsHide: true });
  await execute('git', ['add', '.'], { cwd: repository, windowsHide: true });
  await execute(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-m',
      'Fixture baseline',
    ],
    { cwd: repository, windowsHide: true },
  );
  return { root, repository, skill, officeBundle, paper };
}

test('GEPA preparation freezes inputs, builds valid candidate/template Bundles and enforces model-only Harbor networking', async () => {
  const data = await fixture();
  try {
    const options = {
      ...data,
      image,
      model: 'deepseek-v4.1-flash',
      output: join(data.repository, '.rsi', 'prepared'),
    };
    let imageChecks = 0;
    const result = await prepareGepaDevelopment(options, {
      verifyImage: async (actual, lock) => {
        imageChecks++;
        assert.equal(actual, image);
        assert.match(lock, /^[a-f0-9]{64}$/);
        return { controlled: true };
      },
    });
    assert.equal(imageChecks, 1);
    const manifest = JSON.parse(
      await readFile(join(result.output, 'prepared.json'), 'utf8'),
    );
    assert.equal(manifest.verification.development, 'not-run');
    assert.deepEqual(
      new Set(Object.values(manifest.roleModels)),
      new Set(['deepseek-v4.1-flash']),
    );
    assert.deepEqual(manifest.baselineTransformations.omitted, [
      'skills/ember-rsi',
    ]);
    assert.equal(
      await readFile(
        join(data.repository, 'skills/ember-rsi/SKILL.md'),
        'utf8',
      ),
      'Stale repository copy\n',
    );
    const recipe = parse(await readFile(result.recipe, 'utf8'));
    const evaluator = recipe.bindings.evaluator.config;
    assert.equal(recipe.bindings.agent.config.model, 'deepseek-v4.1-flash');
    assert.equal(
      evaluator.development.sdk.services.default.model,
      'deepseek-v4.1-flash',
    );
    assert.equal(
      evaluator.preflight.sdk.services.default.model,
      'deepseek-v4.1-flash',
    );
    assert.notEqual(
      evaluator.development.bundle,
      recipe.application.config.baseline.directory,
    );
    await assert.rejects(
      readFile(join(evaluator.development.bundle, 'skills/ember-rsi/SKILL.md')),
      { code: 'ENOENT' },
    );
    assert.match(
      await readFile(
        join(
          recipe.application.config.baseline.directory,
          'skills/ember-rsi/SKILL.md',
        ),
        'utf8',
      ),
      /Current authoritative skill/,
    );
    await createBundleSdk().verify(
      recipe.application.config.baseline.directory,
    );
    await createBundleSdk().verify(evaluator.development.bundle);
    const runtimeBundle = join(data.root, 'runtime-bundle');
    await cp(evaluator.development.bundle, runtimeBundle, { recursive: true });
    await cp(
      data.skill,
      join(runtimeBundle, 'plugins/development/skills/ember-rsi'),
      { recursive: true },
    );
    const runtimePrompt = join(
      runtimeBundle,
      'plugins/development/prompts/development.md',
    );
    const skillText = await readFile(join(data.skill, 'SKILL.md'), 'utf8');
    await writeFile(
      runtimePrompt,
      `${await readFile(runtimePrompt, 'utf8')}\n\n${skillText}`,
    );
    const installSdk = createBundleSdk({
      env: {},
      registryPath: join(data.root, 'install-registry.json'),
      runDsh: async () => {},
    });
    const installed = await installSdk.install(runtimeBundle, {
      home: join(data.root, 'installed-home'),
      profileName: 'fixture-development',
    });
    const installedPlugin = join(
      installed.home,
      'profiles',
      installed.profile,
      '.bundle-plugins/development',
    );
    await rm(runtimeBundle, { recursive: true, force: true });
    const plugin = await import(
      pathToFileURL(join(installedPlugin, 'index.js')).href
    );
    const sections = [];
    plugin.apply({
      systemPrompt: { section: (value) => sections.push(value) },
    });
    assert.equal(sections.length, 1);
    assert.ok(sections[0].text.includes(skillText));
    assert.ok(
      sections[0].text.includes(join(installedPlugin, 'skills/ember-rsi')),
    );
    assert.equal(
      await readFile(
        join(installedPlugin, 'skills/ember-rsi/references/guide.md'),
        'utf8',
      ),
      'Fixed reference.\n',
    );
    assert.equal(
      await readFile(
        join(installedPlugin, 'skills/ember-rsi/assets/example.mjs'),
        'utf8',
      ),
      'export const fixed = true;\n',
    );
    const harbor = parseHarborConfig(
      evaluator.development.sdk.benchmark.config,
    );
    const taskDirectory = join(
      evaluator.development.taskPackage,
      evaluator.development.taskDirectory,
    );
    assert.match(
      await readFile(
        join(taskDirectory, 'environment/materials/requirements.md'),
        'utf8',
      ),
      /deepseek-v4\.1-flash/,
    );
    const task = await loadGenericHarborTask(
      taskDirectory,
      evaluator.development.taskPackage,
      evaluator.development.taskId,
      harbor,
      {
        prepare: async () => ({}),
        verify: async () => {
          throw new Error('No real verifier');
        },
      },
      new AbortController().signal,
    );
    assert.equal(task.solveEnv.network, 'model-api');
    assert.equal(task.solveEnv.env.pnpm_config_verify_deps_before_run, 'false');
    assert.equal(evaluator.development.sdk.environment, 'docker');
    assert.equal(task.artifactCollection.paths[0], '/workspace/repository');
    assert.equal(evaluator.development.deliveryDirectory, 'payload/0');
    assert.deepEqual(await readdir(join(result.output, 'baseline/skills')), []);
    const embedded = await readFile(
      join(taskDirectory, 'environment/repository/src/runtime/fixed.ts'),
      'utf8',
    );
    assert.equal(embedded, 'export const fixed = true;\n');
    const target = parse(
      await readFile(
        join(result.output, 'baseline/.gepa/input/office-target.yaml'),
        'utf8',
      ),
    );
    assert.deepEqual(
      target.entries.map((entry) => entry.path),
      ['plugins/office-base/prompts/office-discipline.md'],
    );
    assert.equal(recipe.budget.elapsedWallMs, 259_200_000);
    assert.equal(recipe.policy.config.maxRounds, 10);
    assert.equal(recipe.bindings.agent.config.api_key, '${MODEL_API_KEY}');
    const validation = await execute(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/entries/cli/main.ts',
        'validate',
        result.recipe,
        '--plugin-dir',
        'src/extensions/skill-development',
      ],
      {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        windowsHide: true,
      },
    );
    assert.equal(JSON.parse(validation.stdout).valid, true);
    await assert.rejects(
      prepareGepaDevelopment(options, {
        verifyImage: async () => ({ controlled: true }),
      }),
      { code: 'EEXIST' },
    );
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test('GEPA preparation rejects mutable images, invalid PDFs and output paths outside its data directory', async () => {
  const data = await fixture();
  try {
    const verifyImage = async () => ({ controlled: true });
    await assert.rejects(
      prepareGepaDevelopment(
        { ...data, image: 'mutable:latest' },
        { verifyImage },
      ),
      /immutable/,
    );
    await assert.rejects(
      prepareGepaDevelopment(
        { ...data, image, output: join(data.root, 'outside') },
        { verifyImage },
      ),
      /descendant/,
    );
    await writeFile(data.paper, 'Not a PDF');
    await assert.rejects(
      prepareGepaDevelopment({ ...data, image }, { verifyImage }),
      /local PDF/,
    );
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test('GEPA preparation rejects an output ancestor junction that escapes its data directory', async () => {
  const data = await fixture();
  try {
    const runtimeData = join(data.repository, '.rsi');
    const outside = join(data.root, 'outside');
    await mkdir(runtimeData);
    await mkdir(outside);
    const linkedParent = join(runtimeData, 'existing-junction');
    await symlink(
      outside,
      linkedParent,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      prepareGepaDevelopment(
        { ...data, image, output: join(linkedParent, 'new-output') },
        { verifyImage: async () => ({ controlled: true }) },
      ),
      /descendant/,
    );
    assert.deepEqual(await readdir(outside), []);
    await assert.rejects(readFile(join(outside, 'new-output/prepared.json')), {
      code: 'ENOENT',
    });
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});
