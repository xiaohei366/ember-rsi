import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, open, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AcceptanceRequest {
  attemptId: string;
  sourceDirectory: string;
  recipePath: string;
  pluginDirectory: string;
  outputDirectory: string;
  signal: AbortSignal;
}
export interface AcceptanceProcessResult {
  exitCode: number | null;
  timedOut: boolean;
}

interface AcceptanceProcessOptions {
  /** Internal process-boundary seam; Recipe configuration cannot change the runner. */
  runnerPath?: string;
  cleanupGraceMs?: number;
}

async function terminateTree(pid: number, child?: ChildProcess): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => {
        child?.kill('SIGKILL');
        resolve();
      });
      killer.once('close', (code) => {
        if (code !== 0) child?.kill('SIGKILL');
        resolve();
      });
    });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
      )
        child?.kill('SIGKILL');
    }
  }
}

async function releaseDependencyLink(
  outputDirectory: string,
): Promise<boolean> {
  const path = join(outputDirectory, 'workspace', 'node_modules');
  try {
    if (!(await lstat(path)).isSymbolicLink()) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}

/** Own the runner process group until exit, including abort and stage timeout. */
export async function runAcceptanceProcess(
  request: AcceptanceRequest,
  options: AcceptanceProcessOptions = {},
): Promise<AcceptanceProcessResult> {
  request.signal.throwIfAborted();
  const output = await open(join(request.outputDirectory, 'runner.log'), 'wx');
  const child = spawn(
    process.execPath,
    [
      options.runnerPath ??
        fileURLToPath(new URL('./acceptance-runner.mjs', import.meta.url)),
      request.sourceDirectory,
      request.recipePath,
      request.pluginDirectory,
      request.outputDirectory,
      request.attemptId,
    ],
    {
      cwd: request.sourceDirectory,
      env: process.env,
      stdio: ['ignore', output.fd, output.fd, 'ipc'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    },
  );
  const ownedChildren = new Set<number>();
  child.on('message', (message: unknown) => {
    if (
      !message ||
      typeof message !== 'object' ||
      !('attemptId' in message) ||
      message.attemptId !== request.attemptId ||
      !('pid' in message) ||
      typeof message.pid !== 'number' ||
      !Number.isSafeInteger(message.pid) ||
      message.pid < 1 ||
      !('type' in message)
    )
      return;
    if (message.type === 'rsi.acceptance.child-started')
      ownedChildren.add(message.pid);
    if (message.type === 'rsi.acceptance.child-settled')
      ownedChildren.delete(message.pid);
  });
  let stopping: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forced = false;
  let closed = false;
  const force = (): void => {
    if (stopping || (closed && !ownedChildren.size)) return;
    forced = true;
    stopping = (async () => {
      await Promise.all([...ownedChildren].map((pid) => terminateTree(pid)));
      if (!closed && child.pid) await terminateTree(child.pid, child);
    })();
  };
  const stop = (): void => {
    if (closed || timer || stopping) return;
    timer = setTimeout(force, options.cleanupGraceMs ?? 30000);
    if (child.connected) {
      child.send(
        { type: 'rsi.acceptance.cancel', attemptId: request.attemptId },
        (error) => {
          if (error && !closed) force();
        },
      );
    } else {
      force();
    }
  };
  request.signal.addEventListener('abort', stop, { once: true });
  try {
    const result = await new Promise<AcceptanceProcessResult>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode) => {
          closed = true;
          clearTimeout(timer);
          resolve({ exitCode, timedOut: request.signal.aborted });
        });
        if (request.signal.aborted) stop();
      },
    );
    if (ownedChildren.size && !stopping) force();
    await stopping;
    const dependencyLinkRecovered = await releaseDependencyLink(
      request.outputDirectory,
    );
    await writeFile(
      join(request.outputDirectory, 'runner-status.json'),
      JSON.stringify(
        {
          ...result,
          cancellationRequested: request.signal.aborted,
          termination: forced ? 'forced' : 'normal',
          dependencyLinkRecovered,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    return result;
  } finally {
    request.signal.removeEventListener('abort', stop);
    clearTimeout(timer);
    if ((ownedChildren.size || (!closed && child.pid)) && !stopping) force();
    await stopping;
    try {
      await releaseDependencyLink(request.outputDirectory);
    } finally {
      await output.close();
    }
  }
}
