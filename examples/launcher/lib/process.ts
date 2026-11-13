import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}
export interface Cli {
  root: string;
  env: NodeJS.ProcessEnv;
  entry: string;
  call: (
    args: string[],
    signal?: AbortSignal,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export async function createCli(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<Cli> {
  const entry = join(root, 'dist/src/entries/cli/main.js');
  try {
    await access(entry);
  } catch {
    throw new Error('Build the checkout first: pnpm build');
  }
  return {
    root,
    env,
    entry,
    call: (args, signal) =>
      new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          [entry, ...args],
          {
            cwd: root,
            env,
            windowsHide: true,
            timeout: 120000,
            maxBuffer: 32 * 1024 * 1024,
            signal,
          },
          (error, stdout, stderr) => {
            if (error && (error.killed || typeof error.code !== 'number'))
              reject(error);
            else
              resolve({
                code: typeof error?.code === 'number' ? error.code : 0,
                stdout,
                stderr,
              });
          },
        );
      }),
  };
}

function closed(child: ChildProcess): Promise<Exit> {
  return new Promise((resolve) => {
    child.once('error', (error) =>
      resolve({ code: null, signal: null, error }),
    );
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

/** The detached CLI owns experiment cleanup; its log descriptor survives launcher exit. */
export async function startRun(
  cli: Cli,
  directory: string,
  id: string,
  resume: boolean,
): Promise<{ child: ChildProcess; finished: Promise<Exit> }> {
  const log = await open(join(directory, 'run.log'), 'a', 0o600);
  try {
    const child = spawn(
      process.execPath,
      [
        cli.entry,
        'run',
        join(directory, 'recipe.yaml'),
        '--id',
        id,
        ...(resume ? ['--resume'] : []),
      ],
      {
        cwd: cli.root,
        env: cli.env,
        windowsHide: true,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
      },
    );
    const finished = closed(child);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return { child, finished };
  } finally {
    await log.close();
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address ? address.port : undefined;
      server.close((error) =>
        error
          ? reject(error)
          : port
            ? resolve(port)
            : reject(new Error('No dashboard port was allocated')),
      );
    });
  });
}

async function stopDashboard(
  child: ChildProcess,
  finished: Promise<Exit>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const controller = new AbortController();
  try {
    if (
      (await Promise.race([
        finished,
        delay(5000, null, { signal: controller.signal }),
      ])) === null
    ) {
      child.kill('SIGKILL');
      await finished;
    }
  } finally {
    controller.abort();
  }
}

/** Only GET observation endpoints are used; the temporary dashboard is always stopped. */
export async function withDashboard<T>(
  cli: Cli,
  use: (base: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [cli.entry, 'dashboard', '--port', String(port)],
    {
      cwd: cli.root,
      env: cli.env,
      windowsHide: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const finished = closed(child);
  const base = `http://127.0.0.1:${port}`;
  let stdout = '',
    stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  const abort = (): void => {
    child.kill('SIGTERM');
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Dashboard did not start within 30 seconds')),
        30000,
      );
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(-8192);
        if (stdout.includes(`Dashboard open at ${base}\n`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      void finished.then((exit) => {
        clearTimeout(timer);
        reject(
          exit.error ?? new Error(`Dashboard exited (${exit.code}): ${stderr}`),
        );
      });
    });
    signal?.throwIfAborted();
    return await use(base);
  } finally {
    signal?.removeEventListener('abort', abort);
    await stopDashboard(child, finished);
  }
}

export async function getJson(
  base: string,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`${base}/api/observation${path}`, {
    signal: AbortSignal.any([
      AbortSignal.timeout(10000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok)
    throw new Error(`Observation ${path}: HTTP ${response.status}`);
  return response.json();
}
