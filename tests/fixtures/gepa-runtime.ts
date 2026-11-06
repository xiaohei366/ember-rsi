import { piDefinition } from '../../src/plugins/agent-pi/index.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { stringify } from 'yaml';
import type {
  AgentInput,
  AgentOutput,
  AgentbenchInput,
  AgentbenchOutput,
  ApplicationInput,
  ApplicationOutput,
  JsonObject,
  OperationDefinition,
} from '../../src/contracts/index.js';
import {
  agentContract,
  agentbenchContract,
  applicationContract,
} from '../../src/contracts/index.js';
import {
  evaluationFeedbackSchema,
  typedArtifact,
} from '../../src/contracts/models/measurement.js';
import { object, string } from '../../src/shared/json.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { gepaOptimizerDefinition } from '../../src/plugins/gepa/index.js';

interface EvaluationCall {
  candidateRef: string;
  taskIds: string[];
  files: Record<string, string>;
}

interface AgentCall {
  moduleId: string;
  maxModelCalls: number | undefined;
  modelCalls: number;
  input: JsonObject;
  files: JsonObject;
}

function fileTree(files: Record<string, string>): JsonObject {
  return {
    kind: 'file-tree',
    files: Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => ({
        path,
        mode: 0o644,
        base64: Buffer.from(content, 'utf8').toString('base64'),
      })),
  };
}

export function decodeTree(value: JsonObject): Record<string, string> {
  const files = Array.isArray(value.files) ? value.files : [];
  return Object.fromEntries(
    files.map((entry) => {
      const file = object(entry);
      return [
        string(file.path),
        Buffer.from(string(file.base64), 'base64').toString('utf8'),
      ];
    }),
  );
}

const fakeApplication: OperationDefinition<
  ApplicationInput,
  ApplicationOutput,
  JsonObject
> = {
  id: 'test.gepa-application',
  contract: applicationContract,
  configSchema: { type: 'object' },
  async create(config, services) {
    const baseline = object(config.files ?? {});
    return {
      async execute(input, context) {
        if (input.action === 'initialize') {
          const artifactRef = await services.artifacts.putJson(
            fileTree(
              Object.fromEntries(
                Object.entries(baseline).map(([path, value]) => [
                  path,
                  string(value),
                ]),
              ),
            ),
          );
          const initialCandidateRef = await context.recordCandidate(
            artifactRef,
            null,
          );
          return {
            action: 'initialize',
            initialCandidateRef,
            target: {},
            capabilities: [],
          };
        }
        if (input.action === 'commit') {
          const parent = await context.readCandidate(input.parentCandidateRef);
          const workspace = await services.workspaces.read(input.editRef);
          const tree = fileTree(
            Object.fromEntries(
              await Promise.all(
                Object.keys(baseline).map(async (path) => [
                  path,
                  await (
                    await import('node:fs/promises')
                  ).readFile(join(workspace.directory, path), 'utf8'),
                ]),
              ),
            ),
          );
          const artifactRef = await services.artifacts.putJson(tree);
          if (artifactRef === parent.artifactRef)
            return {
              action: 'commit',
              status: 'no-change',
              candidateRef: parent.ref,
              diffRef: null,
            };
          return {
            action: 'commit',
            status: 'created',
            candidateRef: await context.recordCandidate(
              artifactRef,
              parent.ref,
            ),
            diffRef: await services.artifacts.putJson({ changed: true }),
          };
        }
        if (input.action === 'acquire') {
          return {
            action: 'acquire',
            instanceId: input.instanceId,
            execution: {},
          };
        }
        return {
          action: 'release',
          instanceId: input.instanceId,
          status: 'released',
        };
      },
      async dispose() {},
    };
  },
};

interface ScoreEntry {
  scores: Record<string, number | null>;
  status?: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  comparisonKey?: string | null;
  itemComparisonKey?: string | null;
  metricMapping?: string;
  byTaskSet?: Record<string, ScoreEntry>;
  statuses?: Record<string, 'succeeded' | 'failed' | 'unknown'>;
  marker?: string;
}

function fakeMeasurementPlugin(
  calls: EvaluationCall[],
  scoreTable: Record<string, ScoreEntry>,
  paths: string[],
): OperationDefinition<AgentbenchInput, AgentbenchOutput, JsonObject> {
  return {
    id: 'test.gepa-evaluator',
    contract: agentbenchContract,
    configSchema: { type: 'object' },
    async create(_config, services) {
      return {
        async execute(input, context) {
          const candidate = await context.readCandidate(input.candidateRef);
          const tree = object(
            await context.artifacts.readJson(candidate.artifactRef),
          );
          const files = decodeTree(tree);
          const key = paths.map((path) => files[path] ?? '').join('|');
          const originalEntry = scoreTable[key] ?? {
            scores: Object.fromEntries(
              input.taskIds.map((task: string) => [task, null]),
            ),
            status: 'unknown' as const,
          };
          const entry =
            originalEntry.byTaskSet?.[input.taskIds.slice().sort().join('|')] ??
            originalEntry;
          const status = entry.status ?? 'succeeded';
          calls.push({
            candidateRef: input.candidateRef,
            taskIds: [...input.taskIds],
            files,
          });
          await context.charge('evaluationRuns', 1);
          const emptyArtifact = (id: string) =>
            typedArtifact(
              id,
              { type: 'object' },
              // TypedArtifact needs a real artifact reference, not inline data.
              '',
            );
          void emptyArtifact;
          const provenance = typedArtifact(
            'test.gepa-provenance/v1',
            { type: 'object' },
            await services.artifacts.putJson({
              evaluator: 'deterministic-test',
              candidateRef: candidate.ref,
            }),
          );
          const conditions = typedArtifact(
            'test.gepa-conditions/v1',
            { type: 'object' },
            await services.artifacts.putJson({
              taskIds: input.taskIds,
              fixed: true,
            }),
          );
          const profile = typedArtifact(
            'test.gepa-profile/v1',
            { type: 'object' },
            await services.artifacts.putJson({ kind: 'controlled' }),
          );
          const definitionRef = await services.artifacts.putJson({
            id: 'score',
            description: 'Controlled per-task score',
            unit: 'ratio',
            valueKind: 'scalar',
            version: 1,
            aggregation: 'single point',
            mapping: entry.metricMapping ?? 'fixture',
          });
          const evidenceEntries = input.taskIds.map((task: string) => ({
            id: `trajectory-${task}`,
            kind: 'trajectory',
            artifactRef: null as string | null,
            mediaType: 'text/plain',
            sizeBytes: null,
            itemId: task,
            attemptId: null,
            access: 'execution',
            integrity: 'complete',
          }));
          const evidenceIndexRef = await services.artifacts.putJson({
            schemaVersion: 'rsi.measurement-evidence/v1',
            entries: evidenceEntries,
          });
          // Fill artifact references after creating the index fixture above.
          const catalog = object(
            await services.artifacts.readJson(evidenceIndexRef),
          );
          const withArtifacts = await Promise.all(
            (catalog.entries as unknown[]).map(async (raw) => {
              const item = object(raw);
              const task = string(item.itemId);
              const score = entry.scores[task] ?? null;
              item.artifactRef = await services.artifacts.putJson({
                text: [
                  `TASK_INPUT_MARKER ${task}`,
                  `AGENT_OUTPUT_MARKER ${entry.marker ?? `output-${candidate.ref.slice(-6)}`}`,
                  `SCORE_MARKER ${score === null ? 'unavailable' : String(score)}`,
                ].join('\n'),
              });
              return item;
            }),
          );
          const finalEvidenceRef = await services.artifacts.putJson({
            schemaVersion: 'rsi.measurement-evidence/v1',
            entries: withArtifacts,
          });
          const items = await Promise.all(
            input.taskIds.map(async (task: string) => {
              const score = entry.scores[task] ?? null;
              const taskStatus = entry.statuses?.[task] ?? status;
              const available =
                typeof score === 'number' &&
                status === 'succeeded' &&
                taskStatus === 'succeeded';
              const metric = available
                ? {
                    definitionRef,
                    status: 'available' as const,
                    value: { kind: 'scalar' as const, value: score },
                    source: { artifactRef: finalEvidenceRef, pointer: '' },
                  }
                : {
                    definitionRef,
                    status: 'unavailable' as const,
                    value: null,
                    reason:
                      status === 'succeeded'
                        ? 'No valid scalar was produced'
                        : `Execution was ${status}`,
                    source: { artifactRef: finalEvidenceRef, pointer: '' },
                  };
              const feedback = {
                schemaVersion: 'rsi.evaluation-feedback/v1' as const,
                itemId: task,
                attemptId: null,
                executionStatus:
                  taskStatus === 'succeeded' ? 'completed' : taskStatus,
                scoreStatus: available
                  ? ('valid' as const)
                  : ('unknown' as const),
                passed: available ? score >= 0.5 : null,
                primaryReward: available ? score : null,
                passThreshold: 0.5,
                checks: [
                  {
                    id: 'expected-output',
                    status: available ? 'pass' : 'unknown',
                    score,
                    reason:
                      'The expected output was observed in the execution evidence.',
                    source: { artifactRef: finalEvidenceRef, pointer: '' },
                  },
                ],
                checksComplete: true,
                diagnostics: [
                  {
                    kind: 'feedback',
                    code: null,
                    message: `feedback for ${task}`,
                    source: { artifactRef: finalEvidenceRef, pointer: '' },
                    truncated: false,
                  },
                ],
                truncated: false,
                source: { artifactRef: finalEvidenceRef, pointer: '' },
              };
              const evaluation = typedArtifact(
                'rsi.evaluation-feedback/v1',
                evaluationFeedbackSchema,
                await services.artifacts.putJson(feedback),
              );
              return {
                id: task,
                subject: { kind: 'task', id: task, parameters: null },
                status: taskStatus,
                coverage: taskStatus === 'succeeded' ? 'complete' : 'unknown',
                comparisonKey:
                  entry.itemComparisonKey === undefined
                    ? 'controlled'
                    : entry.itemComparisonKey,
                metrics: { score: metric },
                evaluation,
                evidenceIndexRef: finalEvidenceRef,
                details: provenance,
              };
            }),
          );
          const itemsRef = await services.artifacts.putJson({
            schemaVersion: 'rsi.measurement-items/v1',
            items,
          });
          const measurementRef = await context.recordMeasurement({
            schemaVersion: 'rsi.measurement/v1',
            ref: 'pending',
            experimentId: context.experimentId,
            callId: context.callId,
            candidateRef: candidate.ref,
            evaluator: {
              pluginId: 'test.gepa-evaluator',
              implementationDigest: 'deterministic-fixture',
            },
            startedAt: '2026-11-05T00:00:00Z',
            finishedAt: '2026-11-05T00:00:01Z',
            status,
            coverage: status === 'succeeded' ? 'complete' : 'unknown',
            comparisonKey:
              entry.comparisonKey === undefined
                ? 'controlled'
                : entry.comparisonKey,
            conditions,
            provenance,
            metrics: {},
            itemsRef,
            evidenceIndexRef: finalEvidenceRef,
            profile,
            diagnosticsRef: null,
            extensions: [],
          });
          return { measurementRef };
        },
        async dispose() {},
      };
    },
  };
}

function fakeAgentPlugin(
  calls: AgentCall[],
  proposals: Record<string, string | null>,
  reads: number,
): OperationDefinition<AgentInput, AgentOutput, JsonObject> {
  return {
    id: 'test.gepa-agent',
    contract: agentContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(input) {
          const payload = object(input.input ?? {});
          const module = object(payload.module);
          const moduleId = string(module.id);
          const files = object(input.files ?? {});
          const paths = Object.keys(files).sort();
          const modelCalls = reads + 1;
          if (
            typeof input.maxModelCalls === 'number' &&
            modelCalls > input.maxModelCalls
          )
            throw new Error('controlled Agent model-call limit reached');
          for (let index = 0; index < reads; index++) {
            const path = paths[index % paths.length];
            if (path === undefined || typeof files[path] !== 'string')
              throw new Error(
                'controlled Agent read_file target is unavailable',
              );
          }
          calls.push({
            moduleId,
            maxModelCalls:
              typeof input.maxModelCalls === 'number'
                ? input.maxModelCalls
                : undefined,
            modelCalls,
            input: payload,
            files,
          });
          return {
            proposal: proposals[moduleId] ?? null,
            rationale: 'controlled proposal',
          };
        },
        async dispose() {},
      };
    },
  };
}

export async function runGepa(options: {
  seed: number;
  maxRounds: number;
  maxRollouts: number;
  feedbackTasks: string[];
  selectionTasks: string[];
  scoreTable: Record<string, ScoreEntry>;
  proposals: Record<string, string | null>;
  maxModelCalls?: number;
  reads?: number;
  modules?: { id: string; path: string }[];
  realAgentEndpoint?: string;
  signal?: AbortSignal;
  onFailure?: (snapshot: JsonObject) => Promise<void>;
}): Promise<{
  output: JsonObject;
  evaluationCalls: EvaluationCall[];
  agentCalls: AgentCall[];
  manager: Manager;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gepa-runtime-'));
  const registry = new Registry();
  const evaluationCalls: EvaluationCall[] = [];
  const agentCalls: AgentCall[] = [];
  const manager = new Manager({ registry, rootDirectory: root });
  registry.registerOperation(fakeApplication);
  registry.registerOperation(
    fakeMeasurementPlugin(evaluationCalls, options.scoreTable, [
      'a.md',
      'b.md',
    ]),
  );
  if (options.realAgentEndpoint) registry.registerOperation(piDefinition);
  else
    registry.registerOperation(
      fakeAgentPlugin(agentCalls, options.proposals, options.reads ?? 0),
    );
  registry.registerOperation(gepaOptimizerDefinition);
  registry.registerPolicy(
    'policy.gepa',
    resolve('src/policies/gepa/policy.yaml'),
  );
  const recipePath = join(root, 'recipe.yaml');
  await writeFile(
    recipePath,
    stringify({
      schemaVersion: 'rsi.recipe/v1',
      id: 'gepa-runtime-test',
      application: {
        plugin: fakeApplication.id,
        config: { files: { 'a.md': 'A0', 'b.md': 'B0' } },
      },
      policy: {
        id: 'policy.gepa',
        input: { candidateRef: '${{ application.initialCandidate }}' },
        config: {
          feedbackTaskIds: options.feedbackTasks,
          selectionTaskIds: options.selectionTasks,
          maxRounds: options.maxRounds,
          maxRollouts: options.maxRollouts,
          minibatchSize: 2,
          paretoSize: 2,
          seed: options.seed,
          crossoverEvery: 3,
          modules: options.modules ?? [
            { id: 'a', path: 'a.md' },
            { id: 'b', path: 'b.md' },
          ],
          goal: 'Improve both modules.',
          evaluatorBinding: 'evaluator',
          reflectorBinding: 'reflector',
          reflectionMaxModelCalls: options.maxModelCalls ?? 12,
          maxEvidenceBytes: 120000,
        },
      },
      bindings: {
        evaluator: { plugin: 'test.gepa-evaluator', config: {} },
        reflector: options.realAgentEndpoint
          ? {
              plugin: 'agent.pi',
              config: {
                model: 'fixture',
                base_url: options.realAgentEndpoint,
                api_key: '${GEPA_LOCAL_FIXTURE_KEY}',
                maxTokens: 4096,
                contextWindow: 32768,
                thinkingLevel: 'off',
                retries: 0,
                timeoutMs: 10000,
                executionTimeoutMs: 30000,
              },
            }
          : { plugin: 'test.gepa-agent', config: {} },
      },
      budget: {
        operations: 1000,
        evaluationRuns: 100,
        modelCalls: 1000,
        elapsedWallMs: 60000,
      },
    }),
  );
  let record: JsonObject;
  try {
    record = await manager.run(recipePath, {
      id: 'gepa-runtime',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.onFailure)
      await options.onFailure(await manager.get('gepa-runtime'));
    await manager.dispose();
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    output: object(record.output),
    evaluationCalls,
    agentCalls,
    manager,
    root,
  };
}
