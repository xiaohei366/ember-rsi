import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runAcceptanceProcess } from '../../src/plugins/evaluator-development/process.js';
import { object } from '../../src/shared/json.js';

async function waitForJson(path: string): Promise<ReturnType<typeof object>> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      return object(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
    await delay(10);
  }
  throw new Error(`Child did not publish ${path}`);
}

async function assertProcessStopped(pid: unknown): Promise<void> {
  assert.equal(typeof pid, 'number');
  if (typeof pid !== 'number') throw new Error('Missing child PID');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
        return;
      throw error;
    }
    await delay(10);
  }
  throw new Error(`Owned child ${pid} is still running`);
}

for (const graceful of [true, false]) {
  test(`acceptance ${graceful ? 'IPC cleanup' : 'bounded fallback'} settles the runner and its owned descendant`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'rsi-process-'));
    const output = join(root, 'output');
    await mkdir(output);
    const runnerPath = join(root, 'runner.mjs');
    await writeFile(
      runnerPath,
      `
import { spawn } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const [source, , , output, attemptId] = process.argv.slice(2);
await mkdir(join(output, 'workspace'));
await symlink(source, join(output, 'workspace/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32',
});
process.send({ type: 'rsi.acceptance.child-started', attemptId, pid: descendant.pid });
await writeFile(join(output, 'ready.json'), JSON.stringify({ runnerPid: process.pid, childPid: descendant.pid }));
process.on('message', async (message) => {
  if (!${graceful} || message.type !== 'rsi.acceptance.cancel' || message.attemptId !== attemptId) return;
  const closed = new Promise((accept) => descendant.once('close', accept));
  descendant.kill();
  await closed;
  process.send({ type: 'rsi.acceptance.child-settled', attemptId, pid: descendant.pid });
  await writeFile(join(output, 'cleanup.json'), JSON.stringify({ attemptId, cancelled: true }));
  process.removeAllListeners('message');
  process.disconnect();
});
`,
    );
    const controller = new AbortController();
    try {
      const running = runAcceptanceProcess(
        {
          attemptId: 'process-attempt',
          sourceDirectory: root,
          recipePath: '.gepa/recipe.yaml',
          pluginDirectory: '.gepa/extension',
          outputDirectory: output,
          signal: controller.signal,
        },
        { runnerPath, cleanupGraceMs: graceful ? 5000 : 100 },
      );
      const ready = await waitForJson(join(output, 'ready.json'));
      controller.abort(new Error('Controlled acceptance cancellation'));
      const result = await running;
      assert.equal(result.timedOut, true);
      const status = await waitForJson(join(output, 'runner-status.json'));
      assert.equal(status.termination, graceful ? 'normal' : 'forced');
      assert.equal(status.dependencyLinkRecovered, true);
      assert.equal(
        (await readdir(join(output, 'workspace'))).includes('node_modules'),
        false,
      );
      if (graceful) {
        assert.equal(result.exitCode, 0);
        assert.equal(
          (await waitForJson(join(output, 'cleanup.json'))).cancelled,
          true,
        );
      }
      await assertProcessStopped(ready.runnerPid);
      await assertProcessStopped(ready.childPid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('fixed runner cancels its Runtime and removes prepared dependency links after disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-runner-cancel-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await mkdir(join(source, '.gepa/extension'), { recursive: true });
  await mkdir(output);
  await cp(resolve('pnpm-lock.yaml'), join(source, 'pnpm-lock.yaml'));
  await writeFile(join(source, 'package.json'), '{"type":"module"}\n');
  await writeFile(
    join(source, '.gepa/recipe.yaml'),
    `application:
  plugin: application.agentbundle
  config:
    baseline: { directory: ./input/office-bundle }
`,
  );
  await writeFile(
    join(source, 'runtime.mjs'),
    `
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export async function createRuntime({ directory }) {
  const output = resolve(directory, '..');
  return {
    manager: {
      async run(recipe, { id, signal }) {
        await writeFile(resolve(output, 'runtime-ready.json'), JSON.stringify({ running: true }));
        if (!signal.aborted) await new Promise((accept) => signal.addEventListener('abort', accept, { once: true }));
        return { id, status: 'cancelled' };
      },
      async cancel(id) { await writeFile(resolve(output, 'manager-cancelled.json'), JSON.stringify({ id })); },
      facts: {
        async list() { return []; },
        async read() { throw Object.assign(new Error('No checkpoint yet'), { code: 'ENOENT' }); },
      },
    },
    async dispose() { await writeFile(resolve(output, 'runtime-disposed.json'), JSON.stringify({ disposed: true })); },
  };
}
`,
  );
  await writeFile(
    join(source, 'scripts/build.mjs'),
    `
import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/src', { recursive: true });
await cp('runtime.mjs', 'dist/src/index.js');
`,
  );
  const controller = new AbortController();
  try {
    const running = runAcceptanceProcess({
      attemptId: 'fixed-runner-cancel',
      sourceDirectory: source,
      recipePath: '.gepa/recipe.yaml',
      pluginDirectory: '.gepa/extension',
      outputDirectory: output,
      signal: controller.signal,
    });
    await waitForJson(join(output, 'runtime-ready.json'));
    controller.abort(new Error('Cancel while Runtime owns execution'));
    const result = await running;
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 1);
    assert.equal(
      (await waitForJson(join(output, 'manager-cancelled.json'))).id,
      'fixed-runner-cancel',
    );
    assert.equal(
      (await waitForJson(join(output, 'runtime-disposed.json'))).disposed,
      true,
    );
    const cancellation = await waitForJson(join(output, 'cancellation.json'));
    assert.equal(cancellation.cleanupStatus, 'settled');
    assert.equal(cancellation.runtimeDisposed, true);
    assert.equal(cancellation.dependencyLinkRemoved, true);
    assert.equal(
      (await readdir(join(output, 'workspace'))).includes('node_modules'),
      false,
    );
    assert.equal(
      object((await waitForJson(join(output, 'result.json'))).experiment)
        .status,
      'cancelled',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('already cancelled acceptance never starts a runner', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Already cancelled'));
  await assert.rejects(
    runAcceptanceProcess({
      attemptId: 'not-started',
      sourceDirectory: '.',
      outputDirectory: '.',
      recipePath: 'recipe.yaml',
      pluginDirectory: 'extension',
      signal: controller.signal,
    }),
    /Already cancelled/,
  );
});

test('fixed runner cancellation stops its build tree and preserves build-stage evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-build-cancel-'));
  const source = join(root, 'source');
  const output = join(root, 'output');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await mkdir(join(source, '.gepa'), { recursive: true });
  await mkdir(output);
  await cp(resolve('pnpm-lock.yaml'), join(source, 'pnpm-lock.yaml'));
  await writeFile(join(source, 'package.json'), '{"type":"module"}\n');
  await writeFile(
    join(source, '.gepa/recipe.yaml'),
    `application:
  plugin: application.agentbundle
  config:
    baseline: { directory: ./input/office-bundle }
`,
  );
  await writeFile(
    join(source, 'scripts/build.mjs'),
    `
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
await writeFile(resolve('../build-ready.json'), JSON.stringify({ runnerPid: process.pid, childPid: descendant.pid }));
setInterval(() => {}, 1000);
`,
  );
  const controller = new AbortController();
  try {
    const running = runAcceptanceProcess({
      attemptId: 'build-cancel',
      sourceDirectory: source,
      recipePath: '.gepa/recipe.yaml',
      pluginDirectory: '.gepa/extension',
      outputDirectory: output,
      signal: controller.signal,
    });
    const ready = await waitForJson(join(output, 'build-ready.json'));
    controller.abort(new Error('Cancel during independent build'));
    const result = await running;
    assert.equal(result.timedOut, true);
    const cancellation = await waitForJson(join(output, 'cancellation.json'));
    assert.equal(cancellation.phase, 'build');
    assert.equal(cancellation.cleanupStatus, 'settled');
    assert.equal(cancellation.dependencyLinkRemoved, true);
    assert.equal(
      (await waitForJson(join(output, 'runner-status.json'))).termination,
      'normal',
    );
    await assertProcessStopped(ready.runnerPid);
    await assertProcessStopped(ready.childPid);
    assert.equal(
      (await readdir(join(output, 'workspace'))).includes('node_modules'),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
