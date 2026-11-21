import type { JsonObject } from '../../contracts/json.js';
import type { LearningKind } from '../../contracts/learning.js';
import type { LearningActivation } from '../manager/activation.js';
import { remember } from './memory.js';
import type { LearningResult } from './records.js';
import { reflect, type ReflectionOptions } from './reflection.js';
import type { CycleOptions } from './runner.js';
import type { MemoryConfig, ReflectionConfig } from './schema.js';

type CoordinatorOptions = Pick<
  CycleOptions,
  'context' | 'directory' | 'getDefinition' | 'callId' | 'invoke'
> & {
  memory?: MemoryConfig;
  reflection?: ReflectionConfig;
  activation: LearningActivation;
  attempt?: string;
  sourceResources: ReflectionOptions['sourceResources'];
  diagnose(event: string, error: unknown): void;
};

/** Dispatch serial Policy hooks against the current activation and their durable attempts. */
export class LearningCoordinator {
  readonly memory: MemoryConfig | undefined;
  readonly reflection: ReflectionConfig | undefined;
  private readonly priorRuns = new Map<string, JsonObject[]>();

  constructor(private readonly options: CoordinatorOptions) {
    this.memory = options.memory;
    this.reflection = options.reflection;
  }

  memoryRef(): string | null {
    return this.memory ? (this.options.activation.memory?.ref ?? null) : null;
  }

  async restore(): Promise<void> {
    const { context, activation } = this.options;
    const records = context.facts.scan
      ? context.facts.scan('learning-runs')
      : await context.facts.list('learning-runs');
    for await (const record of records) {
      if (
        record.experimentId !== context.experimentId ||
        record.policyScopeId !== 'root' ||
        typeof record.stepPath !== 'string'
      )
        continue;
      const prior = this.priorRuns.get(record.stepPath) ?? [];
      prior.push(record);
      this.priorRuns.set(record.stepPath, prior);
    }
    await activation.restore();
  }

  async execute(
    kind: LearningKind,
    stepPath: string,
    triggerPath: string,
  ): Promise<LearningResult> {
    const {
      context,
      activation,
      attempt,
      invoke,
      callId,
      directory,
      getDefinition,
      sourceResources,
    } = this.options;
    const common = {
      invocation: {
        policyScopeId: 'root',
        stepPath,
        triggerPath,
        ...(attempt ? { attempt } : {}),
      },
      priorAttempts: this.priorRuns.get(stepPath),
      context,
      directory,
      invoke,
      callId,
      getDefinition,
      bindings: activation.bindings,
      revisionRefs: activation.revisionRefs,
    };
    if (kind === 'reflection' && this.reflection)
      return reflect({
        ...common,
        config: this.reflection,
        sourceResources,
        initialize: (parents) => activation.initialize(parents),
        save: (changes, revisions, id) =>
          activation.saveRevisions(changes, revisions, id),
      });
    if (kind !== 'memory' || !this.memory)
      throw new Error('Unknown learning module ' + kind);
    const previous = activation.memory;
    const result = await remember({
      ...common,
      config: this.memory,
      active: () => activation.memory,
      saveMemory: (memory, id) => activation.saveMemory(memory, id),
    });
    // A terminal result may be replayed after interruption between the learning and Policy journals.
    if (
      common.priorAttempts?.some(
        (run) =>
          run.learningId === result.learningId && run.status === result.status,
      )
    )
      return result;
    try {
      let parentRef = previous?.ref ?? null;
      if (
        result.status === 'activated' &&
        result.memoryRef &&
        result.memoryRef === parentRef
      ) {
        const generated = await context.facts.read(
          'memories',
          result.memoryRef,
        );
        parentRef =
          typeof generated.parentRef === 'string' ? generated.parentRef : null;
      }
      context.event.emit('rsi/memory-updated', {
        experimentId: context.experimentId,
        learningId: result.learningId,
        triggerPath,
        parentRef,
        memoryRef: activation.memory?.ref ?? null,
        artifactRef: activation.memory?.artifactRef ?? null,
        status: result.status,
      });
    } catch (error) {
      this.options.diagnose('rsi/memory-updated', error);
    }
    return result;
  }
}
