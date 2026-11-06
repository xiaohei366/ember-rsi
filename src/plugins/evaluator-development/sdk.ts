import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { JsonObject, RuntimeContext } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { redact } from '../shared/evaluator-adapter/data.js';
import {
  sdkRunner,
  type EvaluatorRunner,
} from '../shared/evaluator-adapter/sdk.js';

export const WORKBUDDY_TASK = 'workbuddy/board-material-update-timeline-excel';
const execute = promisify(execFile);

export function contained(root: string, path: string): string {
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Invalid relative delivery path: ${path}`);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error(`Path escapes directory: ${path}`);
  return target;
}

export function sdkConfiguration(
  config: JsonObject,
  bundle: string,
  taskId: string,
  output: string,
  timeoutMs: number,
): JsonObject {
  const native = structuredClone(config);
  const benchmark =
    typeof native.benchmark === 'string'
      ? { name: native.benchmark }
      : object(native.benchmark);
  const solver =
    typeof benchmark.solver === 'string'
      ? { name: benchmark.solver }
      : object(benchmark.solver ?? {});
  if (solver.name !== undefined && solver.name !== 'agentbundle')
    throw new Error(
      'development/preflight benchmark.solver must be agentbundle',
    );
  solver.name = 'agentbundle';
  solver.config = { ...object(solver.config ?? {}), path: bundle };
  benchmark.solver = solver;
  native.benchmark = benchmark;
  native.output = { directory: output };
  native.run = {
    ...object(native.run ?? {}),
    taskIds: [taskId],
    maxTasks: null,
    offset: 0,
    timeoutSeconds: timeoutMs / 1000,
  };
  native.scheduler = { name: 'local', concurrency: 1 };
  for (const raw of Object.values(object(native.services))) {
    const service = object(raw);
    if (
      service.api_key !== undefined &&
      !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(string(service.api_key))
    )
      throw new Error(
        'development/preflight services.api_key must be an environment reference',
      );
  }
  return native;
}

export interface StageResult {
  raw: JsonObject;
  timedOut: boolean;
  diagnostic: JsonObject | null;
}

/** Expected task failures stay data here, before the Runtime's fatal call boundary. */
export async function executeSdk(
  native: JsonObject,
  context: RuntimeContext,
  timeoutMs: number,
  runner: EvaluatorRunner = sdkRunner,
): Promise<StageResult> {
  const configPath = join(
    string(object(native.output).directory),
    '..',
    'evaluator.json',
  );
  await mkdir(resolve(configPath, '..'), { recursive: true });
  await writeFile(configPath, JSON.stringify(native), {
    mode: 0o600,
    flag: 'wx',
  });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Development stage deadline exceeded')),
    timeoutMs,
  );
  const signal = AbortSignal.any([context.signal, controller.signal]);
  try {
    await context.charge('evaluationRuns', 1);
    try {
      const raw = object(
        await runner({ configPath, signal, env: process.env }),
      );
      return {
        raw: object(redact(raw)),
        timedOut: controller.signal.aborted,
        diagnostic: null,
      };
    } catch (error) {
      const result =
        error instanceof Error && 'result' in error && error.result
          ? object(error.result)
          : {};
      return {
        raw: object(redact(result)),
        timedOut: controller.signal.aborted,
        diagnostic: object(
          redact({
            message: error instanceof Error ? error.message : String(error),
            phase:
              error instanceof Error &&
              'phase' in error &&
              typeof error.phase === 'string'
                ? error.phase
                : null,
          }),
        ),
      };
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function sdkRecords(raw: JsonObject): JsonObject[] {
  const snapshot = raw.snapshot === undefined ? {} : object(raw.snapshot);
  return Array.isArray(snapshot.records)
    ? snapshot.records.map((record) => object(record))
    : [];
}

export function preflightPassed(raw: JsonObject): boolean {
  const snapshot = raw.snapshot === undefined ? {} : object(raw.snapshot);
  return (
    sdkRunMatches(raw, WORKBUDDY_TASK) &&
    raw.exitCode === 0 &&
    object(snapshot.run ?? {}).status === 'completed' &&
    sdkRecords(raw).some(
      (record) =>
        object(record.key).taskId === WORKBUDDY_TASK &&
        record.executionStatus === 'completed' &&
        record.verdict !== null &&
        record.verdict !== undefined &&
        record.scoreStatus === 'valid',
    )
  );
}

export function sdkRunMatches(raw: JsonObject, taskId: string): boolean {
  const snapshot = object(raw.snapshot ?? {});
  const run = object(snapshot.run ?? {});
  const records = sdkRecords(raw);
  return (
    Array.isArray(run.taskIds) &&
    run.taskIds.length === 1 &&
    run.taskIds[0] === taskId &&
    records.length === 1 &&
    object(records[0].key).taskId === taskId &&
    object(records[0].key).runId === run.runId &&
    Array.isArray(snapshot.pendingTaskIds) &&
    snapshot.pendingTaskIds.length === 0
  );
}

/** Retain and extract only regular archive entries; archive links never reach acceptance. */
export async function collectDelivery(
  raw: JsonObject,
  sdkOutput: string,
  destination: string,
  deliveryPath: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (typeof raw.runDirectory !== 'string') return null;
  const root = resolve(raw.runDirectory);
  const rel = relative(resolve(sdkOutput), root);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.includes(':'))
    throw new Error('SDK runDirectory escapes owned output');
  const records = sdkRecords(raw);
  if (records.length !== 1) return null;
  const key = object(records[0].key);
  const attemptId = string(key.attemptId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(attemptId))
    throw new Error('Invalid SDK attempt identity');
  const tasks = join(root, 'tasks');
  let archive: string | null = null;
  for (const task of await readdir(tasks).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return [];
    throw error;
  })) {
    if (task.includes('/') || task.includes('\\'))
      throw new Error('Invalid SDK task path');
    const attempt = join(tasks, task, 'attempts', attemptId);
    try {
      for (const ancestor of [
        root,
        tasks,
        join(tasks, task),
        join(tasks, task, 'attempts'),
      ]) {
        const stat = await lstat(ancestor);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error('Symbolic SDK output ancestor rejected');
      }
      if ((await lstat(attempt)).isSymbolicLink())
        throw new Error('Symbolic SDK attempt rejected');
      const saved = object(
        JSON.parse(await readFile(join(attempt, 'result.json'), 'utf8')),
      );
      if (
        object(saved.key).taskId !== key.taskId ||
        object(saved.key).attemptId !== attemptId
      )
        continue;
      const candidateArchive = join(attempt, 'artifacts', 'artifacts.tar');
      const archiveStat = await lstat(candidateArchive);
      if (!archiveStat.isFile() || archiveStat.isSymbolicLink())
        throw new Error('Delivery archive must be a regular file');
      archive = candidateArchive;
      break;
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
  }
  if (!archive) return null;
  const names = (
    await execute('tar', ['-tf', archive], {
      signal,
      windowsHide: true,
      maxBuffer: 16000000,
    })
  ).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  for (const name of names) {
    const normalized = name.replace(/\/$/, '');
    contained(destination, normalized);
    if (posix.normalize(normalized) !== normalized)
      throw new Error('Non-canonical archive path');
  }
  const kinds = (
    await execute('tar', ['-tvf', archive], {
      signal,
      windowsHide: true,
      maxBuffer: 16000000,
    })
  ).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  if (kinds.some((line) => !['-', 'd'].includes(line[0])))
    throw new Error('Delivery archive contains a link or special file');
  await mkdir(destination, { recursive: true });
  await execute('tar', ['-xf', archive, '-C', destination], {
    signal,
    windowsHide: true,
    maxBuffer: 16000000,
  });
  const source = contained(destination, deliveryPath);
  try {
    return (await lstat(source)).isDirectory() ? source : null;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}
