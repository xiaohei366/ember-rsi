import type {
  JsonObject,
  JsonValue,
  PluginContract,
  RuntimeContext,
} from '../../contracts/index.js';
import type { Policy } from './policy.js';
import {
  canonical,
  digest,
  object,
  string,
  freezeSnapshot,
} from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import type {
  LearningKind,
  LearningTrigger,
} from '../../contracts/learning.js';
import { matchesStepPath } from '../learning/trigger.js';
import { evaluateTemplate } from './expression.js';
import {
  type Step,
  type StepContext,
  type StepResult,
  type Template,
} from './steps.js';
import {
  checkpointVersion,
  readPolicyCheckpoint,
  type IncrementalPolicyCheckpoint,
  type PolicyCheckpointChange,
} from './checkpoint.js';
export interface PolicyOptions {
  input?: JsonObject;
  config?: JsonObject;
  application: JsonObject;
  context: RuntimeContext;
  invoke(
    binding: string,
    input: JsonValue,
    stablePath: string,
    parallel: boolean,
  ): Promise<JsonValue>;
  learning?: {
    memory?: { trigger: readonly LearningTrigger[] };
    reflection?: { trigger: readonly LearningTrigger[] };
    memoryRef(): string | null;
    execute(
      kind: LearningKind,
      hookKey: string,
      triggerPath: string,
    ): Promise<JsonValue>;
  };
  checkpoint(snapshot: JsonObject): Promise<void>;
  restore?: JsonObject;
  recovery?: PolicyRecovery;
  routing?: {
    committedOutput?(path: string): JsonValue | undefined;
  };
  events?: {
    info: {
      experimentId: string;
      policyScopeId: string;
      checkpointRef: string;
    };
    diagnose(eventName: string, error: unknown): void;
  };
}
/** Incremental execution extends the entrypoint without weakening the snapshot callback contract. */
export type PolicyExecutionOptions =
  | (PolicyOptions & { incrementalCheckpoint?: never })
  | (Omit<PolicyOptions, 'checkpoint'> & {
      checkpoint?: never;
      incrementalCheckpoint: IncrementalPolicyCheckpoint;
    });
interface Frame {
  declared: ReadonlySet<string>;
  outputs: JsonObject;
}
interface Environment {
  frames: readonly Frame[];
  locals: JsonObject;
}

function changedFields(
  before: JsonObject,
  after: JsonObject,
  explicit: readonly string[] = [],
): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(after))
    if (
      explicit.includes(key) ||
      !Object.hasOwn(before, key) ||
      canonical(before[key]) !== canonical(value)
    )
      result[key] = structuredClone(value);
  return result;
}
function stepResult(value: JsonValue): StepResult {
  const result = object(value, 'checkpoint.result');
  if (result.kind === 'completed')
    return { kind: 'completed', output: structuredClone(result.output!) };
  if (result.kind === 'break' || result.kind === 'continue')
    return { kind: result.kind };
  throw new Error('checkpoint.result.kind is invalid');
}

type PolicyInvocation = (
  contract: PluginContract,
  binding: string,
  input: JsonValue,
  stablePath: string,
  parallel: boolean,
) => Promise<JsonValue>;

function validatedInvocation(
  options: PolicyExecutionOptions,
): PolicyInvocation {
  return async (contract, binding, input, path, parallel) => {
    validate(contract.input_schema, input, `${binding}.input`);
    const value = await options.invoke(binding, input, path, parallel);
    options.context.signal.throwIfAborted();
    const result = structuredClone(value);
    validate(contract.output_schema, result, `${binding}.output`);
    return result;
  };
}
type PolicyInputs = Pick<PolicyOptions, 'application' | 'input' | 'config'>;
export interface PolicyRecovery {
  identity: string;
  initialState: JsonObject;
}

function initializePolicy(
  policy: Policy,
  options: PolicyInputs,
  restoredState?: JsonObject,
) {
  const application = freezeSnapshot(
    structuredClone(object(options.application, 'application')),
  );
  const config = structuredClone(
    object(options.config === undefined ? {} : options.config, 'policy.config'),
  );
  validate(policy.configSchema, config, 'policy.config');
  freezeSnapshot(config);
  const base = { application, config };
  const supplied = object(
    evaluateTemplate(options.input === undefined ? {} : options.input, base),
    'policy.input',
  );
  const missing = Object.fromEntries(
    Object.entries(policy.inputDefaults).filter(
      ([name]) => !Object.hasOwn(supplied, name),
    ),
  );
  const defaults = object(
    evaluateTemplate(missing, base),
    'policy.input defaults',
  );
  const input = structuredClone({ ...defaults, ...supplied });
  validate(policy.inputSchema, input, 'policy.input');
  freezeSnapshot(input);
  const state = structuredClone(
    restoredState ??
      object(
        evaluateTemplate(policy.stateInitial, { ...base, input }),
        'policy.state',
      ),
  );
  validate(policy.stateSchema, state, 'policy.state');
  freezeSnapshot(state);
  return { application, config, input, state };
}

function checkpointIdentity(
  policy: Policy,
  { application, input, config }: ReturnType<typeof initializePolicy>,
): string {
  return digest({ policy: policy.digest, input, config, application });
}

/** Keep the committed journal identity after Manager has checked the Policy shape. */
export function recoverPolicy(
  policy: Policy,
  options: PolicyInputs,
  checkpoint: JsonObject,
): PolicyRecovery {
  const initial = initializePolicy(policy, options);
  return {
    identity: string(checkpoint.identity, 'checkpoint.identity'),
    initialState: initial.state,
  };
}

/** Projects the declared output from a chronologically ordered, committed journal. */
export function partialPolicyOutput(
  policy: Policy,
  options: PolicyInputs,
  checkpoint: JsonObject,
  recovery?: PolicyRecovery,
  memoryRef: string | null = null,
): JsonValue {
  const initial = initializePolicy(policy, options, recovery?.initialState);
  const { application, config, input } = initial;
  const identity = recovery?.identity ?? checkpointIdentity(policy, initial);
  const { journal } = readPolicyCheckpoint(checkpoint, identity);
  let state = initial.state;
  const steps: JsonObject = {};
  for (const [path, raw] of Object.entries(journal)) {
    const record = object(raw);
    state = { ...state, ...object(record.patch) };
    const [, id, child] = path.split('/');
    if (child === undefined && id !== undefined) {
      const result = stepResult(record.result!);
      if (result.kind === 'completed') steps[id] = { output: result.output };
    }
  }
  validate(policy.stateSchema, state, 'policy.state');
  const output = evaluateTemplate(policy.output, {
    application,
    config,
    input,
    state,
    steps,
    memory: { ref: memoryRef },
  });
  validate(policy.outputSchema, output, 'policy.output');
  return output;
}

/** Executes a compiled declaration with per-run state and durable progress. */
export async function runPolicy(
  policy: Policy,
  options: PolicyExecutionOptions,
  invocation: PolicyInvocation = validatedInvocation(options),
): Promise<JsonValue> {
  const signal = options.context.signal;
  signal.throwIfAborted();
  const initial = initializePolicy(
    policy,
    options,
    options.recovery?.initialState,
  );
  const { application, config, input, state: initialState } = initial;
  const base = { application, config };
  let state = initialState;
  const identity =
    options.recovery?.identity ?? checkpointIdentity(policy, initial);
  const {
    journal,
    boundaries,
  }: { journal: JsonObject; boundaries: JsonObject } =
    options.restore === undefined
      ? { journal: {}, boundaries: {} }
      : readPolicyCheckpoint(options.restore, identity);
  let queue = Promise.resolve();
  if (!options.checkpoint && !options.incrementalCheckpoint)
    throw new Error('Policy execution requires a checkpoint adapter');
  async function persist(
    change: Omit<PolicyCheckpointChange, 'identity'>,
  ): Promise<void> {
    // Snapshot-only callers retain their v1 contract; production stores append a single record.
    const append = options.incrementalCheckpoint;
    const snapshot = options.checkpoint;
    let write: () => Promise<void>;
    if (append) {
      const value = structuredClone({ identity, ...change });
      write = () => append.append(value);
    } else {
      if (!snapshot)
        throw new Error('Policy execution requires a checkpoint adapter');
      const value = structuredClone({
        schemaVersion: checkpointVersion,
        identity,
        journal,
        boundaries,
      });
      write = () => snapshot.call(options, value);
    }
    queue = queue.then(async () => {
      signal.throwIfAborted();
      await write();
      signal.throwIfAborted();
    });
    await queue;
  }
  function updateState(patch: JsonObject, parallel: boolean): JsonObject {
    if (parallel)
      throw new Error('parallel execution cannot write shared state');
    const before = state;
    const proposed = structuredClone({ ...state, ...patch });
    validate(policy.stateSchema, proposed, 'policy.state');
    const committed = changedFields(before, proposed, Object.keys(patch));
    state = freezeSnapshot(proposed);
    return committed;
  }
  const eventInfo = options.events && {
    ...options.events.info,
    policyId: policy.id,
  };
  function notify(eventName: string, publish: () => void): void {
    try {
      publish();
    } catch (error) {
      options.events!.diagnose(eventName, error);
    }
  }
  async function boundary(path?: string, iteration?: number): Promise<void> {
    signal.throwIfAborted();
    const key =
      path === undefined
        ? 'policy-completed'
        : `${path}/iteration-${iteration}`;
    if (Object.hasOwn(boundaries, key)) return;
    boundaries[key] = true;
    await persist({ kind: 'boundary', path: key, value: true });
    if (eventInfo)
      await options.context.event.serial('rsi/policy-boundary-completed', {
        ...eventInfo,
        boundary:
          path === undefined ? 'policy-completed' : 'iteration-completed',
        ...(path === undefined ? {} : { stepPath: path, iteration }),
      });
    signal.throwIfAborted();
  }
  function environment(scope: Environment, extra: JsonObject = {}): JsonObject {
    const outputs: JsonObject = {};
    for (const frame of scope.frames) {
      for (const name of frame.declared) delete outputs[name];
      Object.assign(outputs, frame.outputs);
    }
    return {
      ...base,
      input,
      state,
      steps: outputs,
      memory: { ref: options.learning?.memoryRef() ?? null },
      ...scope.locals,
      ...extra,
    };
  }
  function evaluate(
    template: Template,
    scope: Environment,
    extra?: JsonObject,
  ): JsonValue {
    return structuredClone(
      evaluateTemplate(template, environment(scope, extra)),
    );
  }
  const locations = new Map(
    policy.flowIndex.locations.map((entry) => [entry.step, entry.location]),
  );
  const learningKinds = ['memory', 'reflection'] as const;
  async function runHooks(
    boundary: 'afterStep' | 'afterIteration' | 'afterPolicy',
    location: string,
    path: string,
    scope: Environment,
    iteration?: { index: number; hasNext: boolean },
  ): Promise<void> {
    const learning = options.learning;
    if (!learning) return;
    if (boundary === 'afterIteration' && Object.hasOwn(boundaries, path))
      return;
    if (
      boundary === 'afterPolicy' &&
      Object.hasOwn(boundaries, 'policy-completed')
    )
      return;
    const scheduled =
      boundary === 'afterStep' ? object(journal[path]).learning : undefined;
    for (const kind of learningKinds) {
      if (
        boundary === 'afterStep' &&
        !(Array.isArray(scheduled) && scheduled.includes(kind))
      )
        continue;
      const triggers = learning[kind]?.trigger.filter((trigger) =>
        'afterPolicy' in trigger
          ? boundary === 'afterPolicy'
          : 'afterStep' in trigger
            ? boundary === 'afterStep' && trigger.afterStep === location
            : boundary === 'afterIteration' &&
              trigger.afterIteration === location,
      );
      if (!triggers?.length) continue;
      const hookKey = `${path}/@learning/${kind}`;
      if (Object.hasOwn(journal, hookKey)) continue;
      const matches = triggers.some((trigger) => {
        if ('afterIteration' in trigger && iteration) {
          if (
            !iteration.hasNext &&
            (trigger.skipFinal ?? kind === 'reflection')
          )
            return false;
          if ((iteration.index + 1) % (trigger.every ?? 1) !== 0) return false;
        }
        if ('afterStep' in trigger && (trigger.every ?? 1) > 1) {
          const count = Object.keys(journal).filter((key) =>
            matchesStepPath(key, location),
          ).length;
          if (count % trigger.every! !== 0) return false;
        }
        if (trigger.if === undefined) return true;
        const guard = evaluate(trigger.if, scope);
        if (typeof guard !== 'boolean')
          throw new Error(`${hookKey}.if must be boolean`);
        return guard;
      });
      signal.throwIfAborted();
      const output = matches
        ? await learning.execute(kind, hookKey, path)
        : { status: 'skipped-by-trigger' };
      signal.throwIfAborted();
      const record = { result: { kind: 'completed', output }, patch: {} };
      journal[hookKey] = record;
      await persist({ kind: 'step', path: hookKey, value: record });
    }
  }
  async function runStep(
    step: Step,
    scope: Environment,
    path: string,
    parallel: boolean,
  ): Promise<StepResult> {
    signal.throwIfAborted();
    const stepPath = `${path}/${step.id}`;
    let result: StepResult;
    if (Object.hasOwn(journal, stepPath)) {
      const record = object(journal[stepPath]);
      const patch = object(record.patch);
      if (Object.keys(patch).length) updateState(patch, parallel);
      result = stepResult(record.result!);
    } else {
      const before = state;
      let iterationScope = scope;
      const context: StepContext = {
        input,
        config,
        application,
        get state() {
          return state;
        },
        signal,
        stepPath,
        parallel,
        evaluate(template, locals) {
          return evaluate(template, scope, locals);
        },
        async decision(key, choose) {
          const path = `${stepPath}/@${key}`;
          const previous = journal[path];
          if (previous !== undefined) {
            const saved = stepResult(object(previous).result!);
            if (saved.kind !== 'completed')
              throw new Error(`Invalid saved decision ${path}`);
            return saved.output;
          }
          const value = choose();
          if (!options.learning && (!options.routing || value === false))
            return value;
          const record = {
            result: { kind: 'completed', output: value },
            patch: {},
          };
          journal[path] = record;
          await persist({ kind: 'step', path, value: record });
          return value;
        },
        async invoke(binding, payload) {
          signal.throwIfAborted();
          const contract = policy.requirements[binding];
          if (!contract)
            throw new Error(`${stepPath}: undeclared dependency ${binding}`);
          const committed = options.routing?.committedOutput?.(stepPath);
          if (committed !== undefined) return structuredClone(committed);
          const value = await invocation(
            contract,
            binding,
            structuredClone(payload()),
            stepPath,
            parallel,
          );
          signal.throwIfAborted();
          return structuredClone(value);
        },
        updateState(patch) {
          signal.throwIfAborted();
          return updateState(patch, parallel);
        },
        assertParallelHooks() {
          const prefix = locations.get(step)! + '/';
          for (const kind of learningKinds)
            if (
              options.learning?.[kind]?.trigger.some(
                (trigger) =>
                  !('afterPolicy' in trigger) &&
                  ('afterStep' in trigger
                    ? trigger.afterStep
                    : trigger.afterIteration
                  ).startsWith(prefix),
              )
            )
              throw new Error(
                `${stepPath}: parallel foreach contains a ${kind} learning trigger`,
              );
        },
        iterationHooks(index, hasNext) {
          return runHooks(
            'afterIteration',
            locations.get(step)!,
            `${stepPath}/iteration-${index}`,
            iterationScope,
            { index, hasNext },
          );
        },
        runSteps(children, settings) {
          return runSteps(
            children,
            {
              frames: scope.frames,
              locals: { ...scope.locals, ...settings.locals },
            },
            `${stepPath}/${settings.scope}`,
            parallel || (settings.parallel ?? false),
            settings.output,
            step.type === 'loop'
              ? (inner) => {
                  iterationScope = inner;
                }
              : undefined,
          );
        },
        boundary(iteration) {
          return boundary(stepPath, iteration);
        },
      };
      result = await step.execute(context);
      signal.throwIfAborted();
      // Persist hook eligibility with the business step. Newly enabled hooks must not run at a past boundary.
      const learning = learningKinds.filter((kind) =>
        options.learning?.[kind]?.trigger.some(
          (trigger) =>
            'afterStep' in trigger && trigger.afterStep === locations.get(step),
        ),
      );
      journal[stepPath] = {
        result: structuredClone(result),
        patch: changedFields(before, state),
        ...(learning.length ? { learning } : {}),
      };
      await persist({
        kind: 'step',
        path: stepPath,
        value: journal[stepPath]!,
      });
      if (eventInfo)
        notify('rsi/policy-step-completed', () =>
          options.context.event.emit('rsi/policy-step-completed', {
            ...eventInfo,
            stepPath,
          }),
        );
    }
    return result;
  }
  async function runSteps(
    steps: readonly Step[],
    inherited: Environment,
    path: string,
    parallel: boolean,
    output: Template = null,
    captureScope?: (scope: Environment) => void,
  ): Promise<StepResult> {
    const frame: Frame = {
      declared: new Set(steps.map((step) => step.id)),
      outputs: {},
    };
    const scope: Environment = {
      ...inherited,
      frames: [...inherited.frames, frame],
    };
    captureScope?.(scope);
    for (const step of steps) {
      const result = await runStep(step, scope, path, parallel);
      if (result.kind === 'completed')
        frame.outputs[step.id] = freezeSnapshot({
          output: structuredClone(result.output),
        });
      await runHooks(
        'afterStep',
        locations.get(step)!,
        `${path}/${step.id}`,
        scope,
      );
      if (result.kind !== 'completed') return result;
    }
    if (path === 'steps') await runHooks('afterPolicy', 'steps', path, scope);
    signal.throwIfAborted();
    return { kind: 'completed', output: evaluate(output, scope) };
  }
  if (eventInfo)
    await options.context.event.serial('rsi/policy-started', {
      ...eventInfo,
      resumed: options.restore !== undefined,
    });
  signal.throwIfAborted();
  const result = await runSteps(
    policy.steps,
    { frames: [], locals: {} },
    'steps',
    false,
    policy.output,
  );
  if (result.kind !== 'completed')
    throw new Error('Policy control escaped its loop');
  await boundary();
  signal.throwIfAborted();
  const output = structuredClone(result.output);
  validate(policy.outputSchema, output, 'policy.output');
  if (eventInfo)
    notify('rsi/policy-completed', () =>
      options.context.event.emit('rsi/policy-completed', eventInfo),
    );
  return output;
}

/** Internal Manager bridge: CallExecutor owns plugin input/output validation. */
export async function executeControlledPolicy(
  policy: Policy,
  options: PolicyExecutionOptions,
): Promise<JsonValue> {
  return runPolicy(
    policy,
    options,
    (_contract, binding, input, path, parallel) =>
      options.invoke(binding, input, path, parallel),
  );
}
