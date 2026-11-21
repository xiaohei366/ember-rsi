import { OperationRejectedError } from '../../contracts/runtime/errors.js';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { agentContract } from '../../contracts/index.js';
import { readMemorySnapshot, type ActiveMemory } from '../learning/memory.js';
import type {
  Binding,
  RuntimeContext,
  CallEventInfo,
  EventPipeline,
  FactStore,
  JsonObject,
  JsonValue,
  Operation,
  OperationDefinition,
} from '../../contracts/index.js';
import { object, digest, json } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { errorText } from '../../shared/errors.js';
import type { Registry } from '../registry/index.js';
import { agentReplayKey } from './retry.js';

interface CallExecutorOptions {
  id: string;
  registry: Registry;
  facts: FactStore;
  revisionRefs: Readonly<JsonObject>;
  memoryForBinding?(bindingId: string): ActiveMemory | null;
  retryCalls?: ReadonlyMap<string, JsonObject>;
  retryRef?: string;
  context(binding: string, id: string, parent: RuntimeContext): RuntimeContext;
  binding(name: string): Binding | undefined;
  operation(
    bindingId: string,
    binding: Binding,
  ): Promise<{ operation: Operation; event: EventPipeline; release(): void }>;
  charge(
    metric: string,
    amount: number,
    context: RuntimeContext,
  ): Promise<void>;
  diagnose(event: string, error: unknown): void;
  onFailure(error: unknown, context: RuntimeContext): void;
}
export interface CallExecutor {
  invoke(
    binding: string,
    input: JsonValue,
    context: RuntimeContext,
    path?: string,
  ): Promise<JsonValue>;
  readonly pending: number;
  close(): void;
  idle(): Promise<void>;
  unconfirmed(): Promise<void>;
}

export function callIdentity(
  experiment: string,
  bindingId: string,
  path: string,
  input: JsonValue,
  attempt?: string,
): string {
  return (
    'call-' +
    digest({
      experiment,
      bindingId,
      path,
      input,
      ...(attempt ? { attempt } : {}),
    }).slice(0, 32)
  );
}

export function createCallExecutor(options: CallExecutorOptions): CallExecutor {
  const { id, context, charge } = options;
  const facts = options.facts;
  const learningFacts: FactStore = {
    read: facts.read.bind(facts),
    list: facts.list.bind(facts),
    ...(facts.scan ? { scan: facts.scan.bind(facts) } : {}),
    async write(kind, key, value) {
      if (kind === 'candidates')
        throw new Error('Learning calls cannot write Application candidates');
      await facts.write(kind, key, value);
    },
  };
  const active = new Map<string, Promise<JsonValue>>();
  const uncertain = new Map<string, () => Promise<void>>();
  const childFailures = new Map<string, unknown>();
  const optionalCalls = new Set<string>();
  let accepting = true;
  const invoke = async (
    bindingId: string,
    input: JsonValue,
    caller: RuntimeContext,
    path?: string,
  ): Promise<JsonValue> => {
    // Admission and registration run without an await, including for old contexts.
    if (!accepting)
      throw new Error('Experiment no longer accepts business calls');
    if (caller.experimentId !== id)
      throw new Error('Call belongs to another experiment');
    let definition: OperationDefinition;
    let agentInput: JsonObject | undefined;
    let project: string | undefined;
    try {
      const selected = options.binding(bindingId);
      if (!selected) throw new Error(`Unknown binding ${bindingId}`);
      definition = options.registry.get(selected.plugin);
      json(input);
      input = structuredClone(input);
      validate(definition.contract.input_schema, input, `${bindingId} input`);
      if (
        optionalCalls.has(caller.callId) &&
        definition.contract.id === 'contract.application' &&
        ['commit', 'initialize'].includes(String(object(input).action))
      )
        throw new Error('Learning calls cannot create Application candidates');
      agentInput =
        definition.contract.id === agentContract.id ? object(input) : undefined;
      project =
        typeof agentInput?.cwd === 'string' ? agentInput.cwd : undefined;
      if (project !== undefined) {
        if (caller.agentProject === undefined) {
          const hash = basename(dirname(project));
          const projects = join(resolve(caller.directory), 'agent-projects');
          if (
            !isAbsolute(project) ||
            project !== join(projects, hash, 'project') ||
            !/^[a-f0-9]{64}$/.test(hash) ||
            agentInput?.role !== undefined
          )
            throw new Error(
              'Agent cwd must be a prepared project owned by this call',
            );
        } else if (
          project !== caller.agentProject ||
          agentInput?.role === undefined
        )
          throw new Error(
            'Agent delegates must use a named role in their parent project',
          );
      }
    } catch (error) {
      options.onFailure(error, caller);
      throw error;
    }
    const preparedAgent =
      agentInput !== undefined &&
      project !== undefined &&
      caller.agentProject === undefined &&
      agentInput.role === undefined
        ? agentReplayKey(
            bindingId,
            caller.callId,
            path ?? caller.callId,
            agentInput,
            `artifact:${basename(dirname(project))}`,
          )
        : undefined;
    const policyReceipt =
      caller.callId === 'root' && path !== undefined
        ? options.retryCalls?.get(path)
        : preparedAgent
          ? options.retryCalls?.get(preparedAgent)
          : undefined;
    const callId =
      typeof policyReceipt?.callId === 'string'
        ? policyReceipt.callId
        : callIdentity(
            id,
            bindingId,
            path ?? caller.callId,
            input,
            bindingId === '_application' &&
              ['acquire', 'release'].includes(String(object(input).action)) &&
              caller.idempotencyKey !== caller.callId
              ? caller.idempotencyKey
              : undefined,
          );
    const existing = active.get(callId);
    if (existing) return existing;
    const checkedOutput = (value: unknown): JsonValue => {
      json(value);
      const output = structuredClone(value);
      validate(
        definition.contract.output_schema,
        output,
        `${bindingId} output`,
      );
      if (
        bindingId === '_application' &&
        object(input).action !== object(output).action
      )
        throw new Error('Application returned wrong action');
      return output;
    };
    const job = (async (): Promise<JsonValue> => {
      let ctx = context(bindingId, callId, caller);
      let projectArtifactRef: string | undefined;
      if (project !== undefined) {
        if (caller.agentProject === undefined) {
          const hash = basename(dirname(project));
          const root = await realpath(caller.directory);
          if (
            (await realpath(project)) !==
              join(root, 'agent-projects', hash, 'project') ||
            !(await lstat(join(project, '.rsi-project'))).isFile()
          )
            throw new Error(
              'Agent cwd does not resolve to its authorized project',
            );
          projectArtifactRef = `artifact:${hash}`;
        }
        ctx = ctx.extend({ agentProject: project });
      }

      let prior: JsonObject | undefined;
      try {
        prior = await options.facts.read('calls', callId);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
      }
      if (prior?.status === 'succeeded') return checkedOutput(prior.output);
      ctx.signal.throwIfAborted();
      // Receipt recovery does not reserve a version; pin it together with its lease.
      const binding = options.binding(bindingId);
      if (!binding) throw new Error(`Unknown binding ${bindingId}`);
      const revisionRef = options.revisionRefs[bindingId];
      const memory = options.memoryForBinding?.(bindingId) ?? null;
      const artifacts = ctx.artifacts;
      let snapshot: ReturnType<typeof readMemorySnapshot> | undefined;
      ctx = ctx.extend({
        readMemory: () => (snapshot ??= readMemorySnapshot(artifacts, memory)),
      });
      const info: CallEventInfo = {
        experimentId: id,
        callId,
        bindingId,
        path: path ?? caller.callId,
        parentCallId: caller.callId,
        bindingRef: binding.plugin,
        memoryRef: memory?.ref ?? null,
        revisionRef: typeof revisionRef === 'string' ? revisionRef : null,
      };
      if (
        bindingId === '_memory' ||
        bindingId === '_reflection' ||
        optionalCalls.has(caller.callId)
      ) {
        optionalCalls.add(callId);
        ctx = ctx.extend({
          facts: learningFacts,
          async recordCandidate() {
            throw new Error(
              'Learning calls cannot create Application candidates',
            );
          },
        });
      }
      const lease = await options.operation(bindingId, binding);
      ctx = ctx.extend({ event: lease.event });
      const freshAttempt =
        prior && options.retryRef && options.retryRef !== prior.retryRef;
      try {
        if (
          prior &&
          (!freshAttempt ||
            !['failed', 'cancelled', 'unknown', 'running'].includes(
              String(prior.status),
            ))
        ) {
          throw new Error(`Call ${callId} requires a new resume attempt`);
        }
        ctx.signal.throwIfAborted();
        const attemptId = prior ? digest(prior).slice(0, 24) : undefined;
        const recoveredFrom = attemptId ? `${callId}-${attemptId}` : null;
        if (attemptId && recoveredFrom) {
          ctx = ctx.extend({
            idempotencyKey: recoveredFrom,
            directory: join(ctx.directory, 'attempts', attemptId),
          });
        }
        await charge('operations', 1, ctx);
        await mkdir(ctx.directory, { recursive: true });
        if (prior && recoveredFrom)
          await options.facts.write('call-attempts', recoveredFrom, prior);
        const receipt: JsonObject = {
          ...info,
          pluginId: binding.plugin,
          contractId: definition.contract.id,
          status: 'running',
          input,
          ...(projectArtifactRef === undefined
            ? {}
            : { agentProjectArtifactRef: projectArtifactRef }),
          startedAt: new Date().toISOString(),
          ...(recoveredFrom ? { recoveredFrom } : {}),
          ...(options.retryRef ? { retryRef: options.retryRef } : {}),
          ...(attemptId ? { attemptId } : {}),
        };
        await options.facts.write('calls', callId, receipt);
        let committed = false;
        // Serialize final receipts with any late settlement after a cleanup timeout.
        let writes = Promise.resolve();
        const commit = (value: JsonObject): Promise<boolean> => {
          const write = writes.then(async () => {
            if (committed) return false;
            await options.facts.write('calls', callId, {
              ...receipt,
              ...value,
              finishedAt: new Date().toISOString(),
            });
            committed = true;
            return true;
          });
          writes = write.then(
            () => {},
            () => {},
          );
          return write;
        };
        uncertain.set(callId, async () => {
          if (
            await commit({
              status: 'unknown',
              error: 'Business work did not settle before cleanup deadline',
            })
          ) {
            try {
              void ctx.event
                .parallel('rsi/call-unknown', { ...info, status: 'unknown' })
                .catch((error: unknown) =>
                  options.diagnose('rsi/call-unknown', error),
                );
            } catch (error) {
              options.diagnose('rsi/call-unknown', error);
            }
          }
        });
        const parentSignal = ctx.signal;
        let output: JsonValue;
        try {
          const decision = await ctx.event.waterfall(
            'rsi/before-call',
            { ...info, status: 'running' },
            async () => ({ kind: 'proceed' }),
          );
          ctx.signal.throwIfAborted();
          if (
            !decision ||
            typeof decision !== 'object' ||
            (decision.kind !== 'proceed' && decision.kind !== 'reject') ||
            (decision.kind === 'reject' &&
              (typeof decision.reason !== 'string' || !decision.reason.trim()))
          )
            throw new Error('Invalid rsi/before-call decision');
          if (decision.kind === 'reject')
            throw new Error(`Call admission rejected: ${decision.reason}`);
          output = checkedOutput(await lease.operation.execute(input, ctx));
          if (ctx.scope) ctx.signal.throwIfAborted();
          if (
            !(await commit({
              status: 'succeeded',
              output,
            }))
          )
            throw new Error(`Call ${callId} outcome remains unconfirmed`);
        } catch (error) {
          const explicit =
            error && typeof error === 'object' && 'status' in error
              ? error.status
              : undefined;
          const status =
            explicit === 'unknown'
              ? 'unknown'
              : explicit === 'cancelled' ||
                  (parentSignal.aborted &&
                    !(
                      childFailures.has(callId) &&
                      childFailures.get(callId) === error
                    ))
                ? 'cancelled'
                : 'failed';
          if (
            await commit({
              status,
              error: errorText(error),
              measurementRef:
                error && typeof error === 'object' && 'measurementRef' in error
                  ? String(error.measurementRef)
                  : null,
            })
          ) {
            // Preserve a failure as it propagates through its owning calls,
            // even after supervision has cancelled the other branches.
            if (status === 'failed' && uncertain.has(caller.callId))
              childFailures.set(caller.callId, error);
            try {
              if (status === 'cancelled')
                await ctx.event.parallel('rsi/call-cancelled', {
                  ...info,
                  status,
                });
              else if (status === 'unknown')
                await ctx.event.parallel('rsi/call-unknown', {
                  ...info,
                  status,
                });
              else
                await ctx.event.parallel('rsi/call-failed', {
                  ...info,
                  status,
                });
            } catch (notificationError) {
              options.diagnose(`rsi/call-${status}`, notificationError);
            }
          }
          throw error;
        } finally {
          childFailures.delete(callId);
          uncertain.delete(callId);
        }
        // Notification errors do not undo a settled optional update.
        const eventName = 'rsi/call-succeeded';
        try {
          await ctx.event.parallel('rsi/call-succeeded', {
            ...info,
            status: 'succeeded',
            ...(output &&
            typeof output === 'object' &&
            !Array.isArray(output) &&
            typeof output.measurementRef === 'string'
              ? { measurementRef: output.measurementRef }
              : {}),
          });
        } catch (error) {
          if (optionalCalls.has(callId)) options.diagnose(eventName, error);
          else
            throw new Error(`Event handling failed: ${eventName}`, {
              cause: error,
            });
        }
        return output;
      } finally {
        lease.release();
      }
    })();
    const supervised = job.catch((error) => {
      if (
        !optionalCalls.has(callId) &&
        !(error instanceof OperationRejectedError && active.has(caller.callId))
      )
        options.onFailure(error, caller);
      throw error;
    });
    active.set(callId, supervised);
    void supervised
      .finally(() => {
        active.delete(callId);
      })
      .catch(() => {});
    return supervised;
  };
  return {
    invoke,
    get pending() {
      return active.size;
    },
    close() {
      accepting = false;
    },
    async idle() {
      while (active.size) await Promise.allSettled([...active.values()]);
    },
    async unconfirmed() {
      await Promise.allSettled([...uncertain.values()].map((mark) => mark()));
    },
  };
}
