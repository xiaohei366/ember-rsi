import { matchesGlob } from 'node:path';
import {
  parseFileTree,
  type ArtifactStore,
  type FactStore,
  type JsonObject,
  type MemorySnapshot,
} from '../../contracts/index.js';
import { canonical, digest, object, string } from '../../shared/json.js';
import { isExecutionActive } from '../manager/execution-lock.js';
import {
  readExperimentCleanupState,
  readExperimentRecord,
} from '../manager/records.js';
import { safeId } from '../storage/index.js';
import type { LearningResult } from './records.js';
import { optionalFact, runLearningCycle, type CycleOptions } from './runner.js';
import type { MemoryConfig } from './validation.js';

export interface ActiveMemory extends JsonObject {
  ref: string;
  artifactRef: string;
  rootRef: string;
}
export function parseActiveMemory(value: unknown): ActiveMemory {
  const record = object(value, 'active Memory');
  return {
    ref: string(record.ref),
    artifactRef: string(record.artifactRef),
    rootRef: string(record.rootRef),
  };
}
export async function readMemorySnapshot(
  artifacts: ArtifactStore,
  memory: ActiveMemory | null,
): Promise<MemorySnapshot | null> {
  if (!memory) return null;
  const tree = parseFileTree(await artifacts.readJson(memory.artifactRef));
  const files: Record<string, string> = Object.create(null);
  for (const file of tree.files) {
    const content = Buffer.from(file.base64, 'base64');
    if (content.includes(0)) continue;
    try {
      files[file.path] = new TextDecoder('utf-8', { fatal: true }).decode(
        content,
      );
    } catch {
      /* Binary seed resources are not exposed through the text interface. */
    }
  }
  if (!Object.keys(files).length) return null;
  return Object.freeze({
    ref: memory.ref,
    artifactRef: memory.artifactRef,
    files: Object.freeze({ ...files }),
  });
}
export async function loadMemorySeed(
  facts: FactStore,
  artifacts: ArtifactStore,
  sourceId: string,
  directory?: string,
): Promise<ActiveMemory> {
  const experiment = readExperimentRecord(
    await facts.read('experiments', safeId(sourceId)),
  );
  const cleanup = await readExperimentCleanupState(facts, sourceId);
  if (
    experiment.status === 'running' ||
    cleanup === 'unresolved' ||
    cleanup === 'invalid' ||
    (await isExecutionActive(directory, sourceId))
  )
    throw new Error(
      'Memory seed experiment is running or has unresolved cleanup: ' +
        sourceId,
    );
  const active = await optionalFact(facts, 'activations', sourceId);
  const ref = active?.memory
    ? parseActiveMemory(active.memory).ref
    : object(experiment.learning ?? {}).memoryRef;
  if (typeof ref !== 'string')
    throw new Error('Experiment has no Memory seed: ' + sourceId);
  const record = await facts.read('memories', ref);
  if (record.experimentId !== sourceId || record.ref !== ref)
    throw new Error('Memory seed ownership mismatch');
  const memory = parseActiveMemory(record);
  parseFileTree(await artifacts.readJson(memory.artifactRef));
  return memory;
}
export async function initializeMemory(options: {
  config: MemoryConfig;
  experimentId: string;
  sourceDirectory?: string;
  directory: string;
  facts: FactStore;
  artifacts: ArtifactStore;
  save(memory: ActiveMemory): Promise<void>;
}): Promise<void> {
  const { config, experimentId, facts, artifacts } = options;
  if (!config.seed) return;
  const source = config.seed.fromExperiment
    ? await loadMemorySeed(
        facts,
        artifacts,
        config.seed.fromExperiment,
        options.directory,
      )
    : null;
  const artifactRef =
    source?.artifactRef ??
    string(config.seedArtifactRef, 'locked seed artifact');
  parseFileTree(await artifacts.readJson(artifactRef));
  const ref =
    'memory-' + digest({ experimentId, artifactRef, seed: 'initial' });
  const memory = { ref, rootRef: ref, artifactRef };
  await facts.write('memories', ref, {
    ...memory,
    experimentId,
    parentRef: null,
    parentArtifactRef: null,
    kind: 'initial',
    status: 'initial',
    sourceDirectory: options.sourceDirectory ?? null,
    ...(source
      ? {
          seededFrom: {
            experimentId: config.seed.fromExperiment!,
            memoryRef: source.ref,
          },
        }
      : {}),
  });
  await options.save(memory);
}
interface MemoryOptions extends CycleOptions {
  config: MemoryConfig;
  active(): ActiveMemory | null;
  saveMemory(memory: ActiveMemory, learningId: string): Promise<void>;
}
export async function remember(
  options: MemoryOptions,
): Promise<LearningResult> {
  const { context, config } = options;
  const includes = async (record: JsonObject): Promise<boolean> => {
    let ref: string | null = options.active()?.ref ?? null;
    const visited = new Set<string>();
    while (ref && !visited.has(ref)) {
      if (ref === record.memoryRef) return true;
      visited.add(ref);
      const parent = (await context.facts.read('memories', ref)).parentRef;
      ref = typeof parent === 'string' ? parent : null;
    }
    return false;
  };
  return runLearningCycle(options, 'memory', {
    includes,
    parentsMatch: (record) =>
      record.parentRef === (options.active()?.ref ?? null),
    async execute(cycle) {
      const { prior, identity } = cycle;
      const parent = options.active();
      if (prior?.status === 'validated') {
        if (!(await includes(prior))) {
          if (prior.parentRef !== (parent?.ref ?? null))
            throw new Error(
              'Memory recovery conflicts with the active snapshot',
            );
          cycle.assertScope();
          await options.saveMemory(parseActiveMemory(prior.memory), identity);
        }
        return cycle.finish('activated', prior);
      }
      const evidence = await cycle.evidence();
      if (!evidence.callCount)
        return cycle.finish('skipped', {
          reason: 'no usable observations in this evidence window',
        });
      const input = {
        goal: config.goal,
        evidenceRefs: [string(evidence.ref)],
        memoryRef: parent?.artifactRef ?? null,
        editConstraints: object(config.editConstraints ?? {}),
      };
      if (
        prior?.status === 'prepared' &&
        canonical(input) !== canonical(prior.input)
      )
        throw new Error('Prepared Memory input changed before recovery');
      const parents = {
        parentRef: parent?.ref ?? null,
        parentArtifactRef: parent?.artifactRef ?? null,
      };
      await cycle.save('prepared', { ...parents, input });
      const result = object(await cycle.invoke(input));
      const reason = result.reason;
      if (typeof reason !== 'string')
        throw new Error('Memory proposal reason must be a string');
      if (result.status === 'no-change')
        return cycle.finish('no-change', { reason, ...parents });
      if (result.status !== 'proposed')
        throw new Error('Invalid Memory proposal');
      const artifactRef = string(result.resourceRef),
        changeRef = string(result.changeRef);
      await context.artifacts.readJson(changeRef);
      const files = async (ref?: string) =>
        new Map(
          (ref
            ? parseFileTree(await context.artifacts.readJson(ref)).files
            : []
          ).map((file) => [file.path, file]),
        );
      const before = await files(parent?.artifactRef),
        after = await files(artifactRef);
      for (const path of after.keys()) {
        let slash = path.indexOf('/');
        while (slash >= 0) {
          if (after.has(path.slice(0, slash)))
            throw new Error('Memory file is also a directory: ' + path);
          slash = path.indexOf('/', slash + 1);
        }
      }
      let count = 0,
        bytes = 0;
      for (const path of new Set([...before.keys(), ...after.keys()])) {
        const oldFile = before.get(path),
          file = after.get(path);
        if (canonical(oldFile ?? null) === canonical(file ?? null)) continue;
        count++;
        if (
          config.editConstraints?.allowedPaths &&
          !config.editConstraints.allowedPaths.some((pattern) =>
            matchesGlob(path, pattern),
          )
        )
          throw new Error('Unauthorized Memory edit: ' + path);
        if (file) {
          if (file.mode & 0o111 || (oldFile && file.mode !== oldFile.mode))
            throw new Error('Memory resource mode change denied');
          const content = Buffer.from(file.base64, 'base64');
          if (content.includes(0))
            throw new Error('Binary Memory resource denied: ' + path);
          new TextDecoder('utf-8', { fatal: true }).decode(content);
          bytes += content.length;
        } else if (oldFile)
          bytes += Buffer.byteLength(oldFile.base64, 'base64');
      }
      if (
        count > (config.editConstraints?.maxChangedFiles ?? Infinity) ||
        bytes > (config.editConstraints?.maxChangedBytes ?? Infinity)
      )
        throw new Error('Memory exceeds edit constraints');
      if (!count) return cycle.finish('no-change', { reason, ...parents });
      const ref =
        'memory-' +
        digest({
          experimentId: context.experimentId,
          identity,
          artifactRef,
          ...parents,
        });
      const memory = { ref, artifactRef, rootRef: parent?.rootRef ?? ref };
      await context.facts.write('memories', ref, {
        ...memory,
        ...parents,
        experimentId: context.experimentId,
        kind: 'generated',
        status: 'validated',
        learningId: identity,
        changeRef,
        reason,
      });
      const validated = { ...parents, memory, memoryRef: ref, reason };
      await cycle.save('validated', validated);
      cycle.assertScope();
      await options.saveMemory(memory, identity);
      return cycle.finish('activated', validated);
    },
  });
}
