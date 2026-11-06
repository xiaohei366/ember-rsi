import {
  cp,
  mkdir,
  readFile,
  realpath,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

// IPC requests normal Runtime cancellation before the parent applies its bounded
// process-tree fallback. The runner owns builds, Runtime cleanup, and dependency links.
const [source, recipe, plugins, output, attemptId] = process.argv.slice(2);
const controller = new AbortController();
let runtime;
let cancellation;
let dependencyLinked = false;
let phase = 'copy';
const workspace = resolve(output, 'workspace');
const directory = resolve(output, 'runtime');

function notify(type, pid) {
  if (process.connected) process.send({ type, attemptId, pid }, () => {});
}

function cancel(message) {
  if (
    !message ||
    typeof message !== 'object' ||
    message.type !== 'rsi.acceptance.cancel' ||
    message.attemptId !== attemptId ||
    controller.signal.aborted
  )
    return;
  controller.abort(new Error('Independent acceptance cancelled'));
  if (runtime) {
    cancellation = runtime.manager.cancel(attemptId).catch((error) => {
      // The AbortSignal also covers startup before the experiment fact exists.
      if (
        error.code === 'ENOENT' ||
        error.message === 'Experiment is not running'
      )
        return;
      throw error;
    });
    void cancellation.catch(() => {});
  }
}
process.on('message', cancel);

async function stopBuild(build) {
  if (!build.pid || build.exitCode !== null || build.signalCode !== null)
    return;
  if (process.platform === 'win32') {
    await new Promise((accept) => {
      const killer = spawn(
        'taskkill',
        ['/PID', String(build.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
      killer.once('error', () => {
        build.kill('SIGKILL');
        accept();
      });
      killer.once('close', (code) => {
        if (code !== 0) build.kill('SIGKILL');
        accept();
      });
    });
  } else {
    try {
      process.kill(-build.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') build.kill('SIGKILL');
    }
  }
}

async function buildSource() {
  controller.signal.throwIfAborted();
  const build = spawn(process.execPath, ['scripts/build.mjs'], {
    cwd: workspace,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let stopping;
  const stop = () => {
    stopping ??= stopBuild(build);
  };
  notify('rsi.acceptance.child-started', build.pid);
  controller.signal.addEventListener('abort', stop, { once: true });
  try {
    const code = await new Promise((accept, reject) => {
      build.once('error', reject);
      build.once('close', accept);
      if (controller.signal.aborted) stop();
    });
    controller.signal.throwIfAborted();
    if (code !== 0)
      throw new Error(`Independent source build exited with ${code}`);
  } finally {
    controller.signal.removeEventListener('abort', stop);
    await stopping;
    notify('rsi.acceptance.child-settled', build.pid);
  }
}

async function frameworkBoundaries(manager) {
  let head;
  try {
    head = await manager.facts.read('checkpoints', attemptId);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const paths = [];
  if (head.schemaVersion === 'rsi.policy-checkpoint/v1') {
    for (const [path, complete] of Object.entries(head.boundaries ?? {}))
      if (complete === true) paths.push(path);
  } else if (
    head.schemaVersion === 'rsi.policy-checkpoint/v2' &&
    Number.isSafeInteger(head.entries) &&
    head.entries > 0
  ) {
    for (let sequence = 0; sequence < head.entries; sequence++) {
      const entry = await manager.facts.read(
        'checkpoint-entries',
        `${attemptId}.${sequence}`,
      );
      if (entry.identity !== head.identity || entry.sequence !== sequence)
        throw new Error('Acceptance checkpoint identity or sequence mismatch');
      if (entry.kind === 'boundary' && entry.value === true)
        paths.push(entry.path);
    }
  } else throw new Error('Unsupported acceptance checkpoint head');
  return paths
    .filter((path) => /^steps\/.+\/iteration-\d+$/.test(path))
    .map((path) => ({
      experimentId: attemptId,
      policyScopeId: 'root',
      boundary: 'iteration-completed',
      stepPath: path,
    }));
}

try {
  await mkdir(output, { recursive: true });
  await cp(source, workspace, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter() {
      controller.signal.throwIfAborted();
      return true;
    },
  });
  controller.signal.throwIfAborted();
  phase = 'prepare';
  let hostRoot = dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      if (
        JSON.parse(await readFile(resolve(hostRoot, 'package.json'), 'utf8'))
          .name === 'ember-rsi'
      )
        break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(hostRoot);
    if (parent === hostRoot)
      throw new Error('Cannot locate prepared ember-rsi dependency root');
    hostRoot = parent;
  }
  if (
    !(await readFile(resolve(hostRoot, 'pnpm-lock.yaml'))).equals(
      await readFile(resolve(workspace, 'pnpm-lock.yaml')),
    )
  )
    throw new Error(
      'Independent acceptance needs prepared dependencies matching the frozen lockfile',
    );
  controller.signal.throwIfAborted();
  await symlink(
    await realpath(resolve(hostRoot, 'node_modules')),
    resolve(workspace, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  dependencyLinked = true;
  const { parseDocument } = await import('yaml');
  const recipePath = resolve(workspace, recipe);
  const document = parseDocument(await readFile(recipePath, 'utf8'), {
    uniqueKeys: true,
  });
  if (document.errors.length)
    throw new Error('Delivered Recipe is not valid YAML');
  const recipeInput = document.toJS({ maxAliasCount: 0 });
  if (
    recipeInput.application?.plugin !== 'application.agentbundle' ||
    typeof recipeInput.application.config?.baseline?.directory !== 'string' ||
    resolve(
      dirname(recipePath),
      recipeInput.application.config.baseline.directory,
    ) !== resolve(workspace, '.gepa/input/office-bundle')
  )
    throw new Error(
      'The delivered Recipe must use the fixed Office AgentBundle baseline',
    );
  phase = 'build';
  await buildSource();
  controller.signal.throwIfAborted();
  const { createRuntime } = await import(
    pathToFileURL(resolve(workspace, 'dist/src/index.js')).href
  );
  runtime = await createRuntime({
    rootDirectory: workspace,
    directory,
    homeDirectory: false,
    pluginDirectories: [resolve(workspace, plugins)],
  });
  phase = 'runtime';
  const experiment = await runtime.manager.run(resolve(workspace, recipe), {
    id: attemptId,
    signal: controller.signal,
  });
  phase = 'collect';
  const boundaries = await frameworkBoundaries(runtime.manager);
  const measurements = [];
  for (const measurement of await runtime.manager.facts.list('measurements')) {
    if (measurement.experimentId !== attemptId) continue;
    const items = await runtime.manager.artifacts.readJson(
      measurement.itemsRef,
    );
    const evaluations = [];
    for (const item of items.items) {
      if (!item.evaluation) continue;
      const feedback = await runtime.manager.artifacts.readJson(
        item.evaluation.artifactRef,
      );
      evaluations.push({
        itemId: item.id,
        artifactRef: item.evaluation.artifactRef,
        feedback,
        nativeRecordRef: feedback.source.artifactRef,
        nativeRecord: await runtime.manager.artifacts.readJson(
          feedback.source.artifactRef,
        ),
      });
    }
    measurements.push({
      measurement,
      items,
      evaluations,
    });
  }
  const candidates = (await runtime.manager.facts.list('candidates')).filter(
    (candidate) => candidate.experimentId === attemptId,
  );
  const calls = (await runtime.manager.facts.list('calls'))
    .filter((call) => call.experimentId === attemptId)
    .map((call) => ({
      ...call,
      contractId: runtime.registry.get(call.pluginId).contract.id,
    }));
  await writeFile(
    resolve(output, 'result.json'),
    JSON.stringify({
      validationVersion: 'rsi.gepa-acceptance/v2',
      attemptId,
      experiment,
      boundaries,
      candidates,
      calls,
      measurements,
    }),
    { flag: 'wx' },
  );
  if (experiment.status !== 'succeeded') process.exitCode = 1;
} catch (error) {
  process.exitCode = 1;
  await writeFile(
    resolve(output, 'runner-error.json'),
    JSON.stringify({
      attemptId,
      phase,
      cancelled: controller.signal.aborted,
      message: error instanceof Error ? error.message : String(error),
    }),
    { flag: 'wx' },
  );
  console.error(error);
} finally {
  const stoppedPhase = phase;
  phase = 'cleanup';
  let cleanupError;
  let runtimeDisposed = false;
  let dependencyLinkRemoved = false;
  try {
    try {
      await cancellation;
    } catch (error) {
      cleanupError = error;
    }
    try {
      await runtime?.dispose();
      runtimeDisposed = Boolean(runtime);
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      if (dependencyLinked) {
        await unlink(resolve(workspace, 'node_modules'));
        dependencyLinkRemoved = true;
      }
    } catch (error) {
      cleanupError ??= error;
    }
    if (controller.signal.aborted || cleanupError)
      await writeFile(
        resolve(output, 'cancellation.json'),
        JSON.stringify({
          attemptId,
          phase: stoppedPhase,
          cancelled: controller.signal.aborted,
          cleanupStatus: cleanupError ? 'unconfirmed' : 'settled',
          runtimeDisposed,
          dependencyLinkRemoved,
          error: cleanupError instanceof Error ? cleanupError.message : null,
        }),
        { flag: 'wx' },
      );
    if (cleanupError) {
      process.exitCode = 1;
      console.error(cleanupError);
    }
  } finally {
    process.removeListener('message', cancel);
    if (process.connected) process.disconnect();
  }
}
