import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { JsonObject } from '../../src/contracts/index.js';
import type { DevelopmentConfig } from '../../src/plugins/evaluator-development/schema.js';
import type { DevelopmentBoundaries } from '../../src/plugins/evaluator-development/service.js';
import { digest, object, string } from '../../src/shared/json.js';
import { evaluationFeedbackSchema } from '../../src/contracts/models/measurement.js';
import { WORKBUDDY_TASK } from '../../src/plugins/evaluator-development/sdk.js';

const execute = promisify(execFile);
const artifact = `artifact:${'0'.repeat(64)}`;
const typed = {
  schemaId: 'fixture/v1',
  schemaDigest: '0'.repeat(64),
  artifactRef: artifact,
};
export type ControlledDevelopment =
  | 'pass'
  | 'development-failure'
  | 'environment-failure'
  | 'uncertain-failure'
  | 'missing-delivery';

export function acceptanceEnvelope(attemptId: string): JsonObject {
  const envelope: JsonObject = {
    attemptId,
    experiment: {
      id: attemptId,
      status: 'succeeded',
      output: { completedRounds: 1 },
      application: {
        initialCandidateRef: 'candidate-office',
        target: {
          entries: [
            {
              path: 'plugins/office-base/prompts/office-discipline.md',
              kind: 'file',
              changes: ['modify'],
            },
          ],
        },
      },
    },
    boundaries: [],
    measurements: [
      {
        measurement: {
          schemaVersion: 'rsi.measurement/v1',
          ref: 'measurement-fixture',
          experimentId: attemptId,
          callId: 'call-eval-baseline',
          candidateRef: 'candidate-office',
          evaluator: {
            pluginId: 'evaluator.agentbench',
            implementationDigest: 'fixture',
          },
          startedAt: new Date(0).toISOString(),
          finishedAt: new Date(1).toISOString(),
          status: 'succeeded',
          coverage: 'complete',
          comparisonKey: null,
          conditions: typed,
          provenance: typed,
          metrics: {},
          itemsRef: artifact,
          evidenceIndexRef: artifact,
          profile: typed,
          diagnosticsRef: null,
          extensions: [],
        },
        items: {
          schemaVersion: 'rsi.measurement-items/v1',
          items: [
            {
              id: WORKBUDDY_TASK,
              subject: { kind: 'task', id: WORKBUDDY_TASK, parameters: null },
              status: 'succeeded',
              coverage: 'complete',
              comparisonKey: null,
              metrics: {},
              evaluation: {
                schemaId: 'rsi.evaluation-feedback/v1',
                schemaDigest: digest(evaluationFeedbackSchema),
                artifactRef: artifact,
              },
              evidenceIndexRef: artifact,
              details: typed,
            },
          ],
        },
        evaluations: [
          {
            itemId: WORKBUDDY_TASK,
            artifactRef: artifact,
            nativeRecordRef: artifact,
            feedback: {
              schemaVersion: 'rsi.evaluation-feedback/v1',
              itemId: WORKBUDDY_TASK,
              attemptId: 'fixture-sdk-attempt',
              executionStatus: 'completed',
              scoreStatus: 'valid',
              passed: false,
              primaryReward: null,
              passThreshold: null,
              checks: [],
              checksComplete: null,
              diagnostics: [],
              truncated: false,
              source: { artifactRef: artifact, pointer: '' },
            },
            nativeRecord: {
              key: {
                runId: 'fixture-sdk-run',
                taskId: WORKBUDDY_TASK,
                attemptId: 'fixture-sdk-attempt',
              },
              executionStatus: 'completed',
              scoreStatus: 'valid',
              cleanupStatus: 'cleaned',
            },
          },
        ],
      },
    ],
  };
  const instant = (value: number): string => new Date(value).toISOString();
  const call = (
    callId: string,
    pluginId: string,
    contractId: string,
    input: JsonObject,
    output: JsonObject,
    start: number,
    finish: number,
    parentCallId = 'root',
  ): JsonObject => ({
    callId,
    pluginId,
    contractId,
    experimentId: attemptId,
    input,
    output,
    parentCallId,
    path: `steps/${callId}`,
    status: 'succeeded',
    startedAt: instant(start),
    finishedAt: instant(finish),
  });
  envelope.candidates = [
    {
      ref: 'candidate-office',
      parentRef: null,
      artifactRef: artifact,
      experimentId: attemptId,
    },
    {
      ref: 'candidate-office-child',
      parentRef: 'candidate-office',
      artifactRef: `artifact:${'1'.repeat(64)}`,
      experimentId: attemptId,
    },
  ];
  envelope.calls = [
    call(
      'call-initialize',
      'application.agentbundle',
      'contract.application',
      { action: 'initialize' },
      { action: 'initialize', initialCandidateRef: 'candidate-office' },
      0,
      1,
    ),
    call(
      'call-eval-baseline',
      'evaluator.agentbench',
      'contract.agentbench',
      { candidateRef: 'candidate-office', taskIds: [WORKBUDDY_TASK] },
      { measurementRef: 'measurement-fixture' },
      1,
      2,
    ),
    call(
      'call-proposal',
      'fixture.proposer',
      'contract.proposer',
      { parent: 'candidate-office' },
      {
        status: 'created',
        candidateRef: 'candidate-office-child',
        diffRef: artifact,
      },
      3,
      6,
    ),
    call(
      'call-commit',
      'application.agentbundle',
      'contract.application',
      { action: 'commit', parentCandidateRef: 'candidate-office' },
      {
        action: 'commit',
        status: 'created',
        candidateRef: 'candidate-office-child',
        diffRef: artifact,
      },
      4,
      5,
      'call-proposal',
    ),
    call(
      'call-eval-child',
      'evaluator.agentbench',
      'contract.agentbench',
      { candidateRef: 'candidate-office-child', taskIds: [WORKBUDDY_TASK] },
      { measurementRef: 'measurement-child-fixture' },
      7,
      8,
    ),
  ];
  if (!Array.isArray(envelope.measurements))
    throw new Error('Fixture measurements missing');
  const child = structuredClone(object(envelope.measurements[0]));
  Object.assign(object(child.measurement), {
    ref: 'measurement-child-fixture',
    callId: 'call-eval-child',
    candidateRef: 'candidate-office-child',
    startedAt: instant(7),
    finishedAt: instant(8),
  });
  envelope.measurements.push(child);
  return envelope;
}

/** Controlled remote results with real task preparation, archive collection and acceptance artifacts. */
export async function developmentFixture(root: string): Promise<{
  config: DevelopmentConfig;
  boundaries: DevelopmentBoundaries;
  state: {
    preflightReady: boolean;
    developmentOutcomes: ControlledDevelopment[];
    acceptanceOutcomes: (
      | 'pass'
      | 'no-task'
      | 'no-round'
      | 'baseline-only'
      | 'environment-failure'
    )[];
    suppliedSkills: string[];
    taskInstructions: string[];
    acceptanceCalls: number;
    developmentCalls: number;
  };
}> {
  const baseline = join(root, 'baseline');
  const taskPackage = join(root, 'task-package');
  const task = join(taskPackage, 'gepa-development');
  const bundle = join(root, 'development-bundle');
  const preflightBundle = join(root, 'office-bundle');
  await mkdir(baseline, { recursive: true });
  await writeFile(
    join(baseline, 'baseline.ts'),
    'export const baseline = true;\n',
  );
  await mkdir(join(task, 'environment'), { recursive: true });
  await cp(baseline, join(task, 'environment', 'repository'), {
    recursive: true,
  });
  await writeFile(
    join(task, 'instruction.md'),
    'Implement GEPA from the paper and use the supplied ember-rsi skill.\n',
  );
  await writeFile(
    join(task, 'task.toml'),
    'version = "1.0"\nartifacts = ["/workspace/repository"]\n[task]\nname = "gepa-development"\n[environment]\nworkdir = "/workspace/repository"\n[agent]\nnetwork_mode = "no-network"\n[verifier]\nnetwork_mode = "no-network"\n',
  );
  await writeFile(
    join(task, 'environment', 'Dockerfile'),
    'FROM scratch\nWORKDIR /workspace/repository\n',
  );
  await mkdir(join(bundle, 'plugins/development/prompts'), { recursive: true });
  await writeFile(
    join(bundle, 'plugins/development/prompts/development.md'),
    'You develop RSI extensions.\n',
  );
  await mkdir(preflightBundle, { recursive: true });
  await writeFile(
    join(preflightBundle, 'office.md'),
    'Fixed Office bundle placeholder at the controlled DSH boundary.\n',
  );
  const services = {
    default: {
      model: 'ds-v4.1-flash',
      base_url: 'https://model.invalid',
      api_key: '${MODEL_API_KEY}',
    },
  };
  const config: DevelopmentConfig = {
    development: {
      sdk: {
        services,
        hardware: 'npu',
        environment: { name: 'docker' },
        benchmark: {
          name: 'harbor',
          config: {
            dataset: 'fixture',
            tasks: { root: '.', id: 'task.name' },
            defaults: { workdir: '/workspace/repository' },
          },
        },
      },
      taskId: 'gepa-development',
      taskPackage,
      taskDirectory: 'gepa-development',
      baselineDirectory: baseline,
      bundle,
      skillPrompt: 'plugins/development/prompts/development.md',
      deliveryDirectory: 'payload/0',
    },
    preflight: {
      sdk: {
        services,
        benchmark: { name: 'workbuddy' },
        environment: { name: 'docker' },
      },
      bundle: preflightBundle,
    },
    acceptance: {
      recipePath: '.gepa/recipe.yaml',
      pluginDirectory: '.gepa/extension',
    },
    developmentTimeoutMs: 10000,
    acceptanceTimeoutMs: 10000,
  };
  const state = {
    preflightReady: true,
    developmentOutcomes: ['pass'] as ControlledDevelopment[],
    acceptanceOutcomes: ['pass'] as (
      | 'pass'
      | 'no-task'
      | 'no-round'
      | 'baseline-only'
      | 'environment-failure'
    )[],
    suppliedSkills: [] as string[],
    taskInstructions: [] as string[],
    acceptanceCalls: 0,
    developmentCalls: 0,
  };
  const boundaries: DevelopmentBoundaries = {
    async runSdk({ configPath, signal }) {
      signal.throwIfAborted();
      const native = object(JSON.parse(await readFile(configPath, 'utf8')));
      const taskId = string((object(native.run).taskIds as string[])[0]);
      const output = string(object(native.output).directory);
      const runDirectory = join(output, 'fixture-run');
      const attemptId = 'attempt-fixture';
      const outcome =
        taskId === WORKBUDDY_TASK
          ? state.preflightReady
            ? 'pass'
            : 'environment-failure'
          : (state.developmentOutcomes[state.developmentCalls] ?? 'pass');
      const record: JsonObject = {
        key: { taskId, attemptId, runId: 'fixture-run' },
        executionStatus:
          outcome === 'uncertain-failure' ? 'failed' : 'completed',
        scoreStatus: 'valid',
        cleanupStatus: 'cleaned',
        phaseDurationMs: { solve: 35, prepare: 100, collect: 50 },
        accounting: {
          usage: { inputTokens: 17, outputTokens: 23, totalTokens: 40 },
          complete: true,
        },
        verdict: { passed: outcome !== 'development-failure' },
        errors:
          outcome === 'environment-failure'
            ? [
                {
                  phase: 'environment',
                  code: 'ENV_DOCKER_DAEMON_UNAVAILABLE',
                  message: 'Controlled unavailable environment',
                },
              ]
            : outcome === 'uncertain-failure'
              ? [
                  {
                    phase: 'solve',
                    code: 'INTERNAL_ERROR',
                    message: 'Controlled uncertainty',
                  },
                ]
              : [],
      };
      const attempt = join(
        runDirectory,
        'tasks',
        'fixture-task',
        'attempts',
        attemptId,
      );
      await mkdir(join(attempt, 'artifacts'), { recursive: true });
      await writeFile(join(attempt, 'result.json'), JSON.stringify(record));
      if (taskId !== WORKBUDDY_TASK) {
        state.developmentCalls++;
        const solver = object(object(native.benchmark).solver);
        state.suppliedSkills.push(
          await readFile(
            join(
              string(object(solver.config).path),
              'plugins/development/skills/ember-rsi/SKILL.md',
            ),
            'utf8',
          ),
        );
        const source = string(
          object(object(object(native.benchmark).config).source).path,
        );
        state.taskInstructions.push(
          await readFile(
            join(source, 'gepa-development/instruction.md'),
            'utf8',
          ),
        );
        if (outcome !== 'missing-delivery') {
          const stage = join(runDirectory, 'archive-staging');
          await cp(baseline, join(stage, 'payload/0'), { recursive: true });
          await mkdir(join(stage, 'payload/0/.gepa/extension'), {
            recursive: true,
          });
          await writeFile(
            join(stage, 'payload/0/.gepa/extension/index.mjs'),
            'export function register() {}\n',
          );
          await writeFile(
            join(stage, 'payload/0/.gepa/recipe.yaml'),
            'schemaVersion: rsi.recipe/v1\n',
          );
          await execute(
            'tar',
            [
              '-cf',
              join(attempt, 'artifacts/artifacts.tar'),
              '-C',
              stage,
              'payload',
            ],
            { windowsHide: true },
          );
        }
      }
      return {
        kind: 'local',
        exitCode: outcome === 'pass' || outcome === 'missing-delivery' ? 0 : 1,
        runId: 'fixture-run',
        runDirectory,
        snapshot: {
          run: { runId: 'fixture-run', taskIds: [taskId], status: 'completed' },
          records: [record],
          pendingTaskIds: [],
          digest: 'fixture',
        },
      };
    },
    async runAcceptance(request) {
      const outcome =
        state.acceptanceOutcomes[state.acceptanceCalls++] ?? 'pass';
      const result = acceptanceEnvelope(request.attemptId);
      if (outcome === 'no-task') result.measurements = [];
      if (outcome === 'no-round')
        object(object(result.experiment).output).completedRounds = 0;
      if (outcome === 'baseline-only') {
        if (
          !Array.isArray(result.measurements) ||
          !Array.isArray(result.candidates) ||
          !Array.isArray(result.calls)
        )
          throw new Error('Fixture framework facts missing');
        result.measurements = result.measurements.slice(0, 1);
        result.candidates = result.candidates.slice(0, 1);
        result.calls = result.calls.filter((raw) =>
          ['call-initialize', 'call-eval-baseline'].includes(
            string(object(raw).callId),
          ),
        );
      }
      await writeFile(
        join(request.outputDirectory, 'result.json'),
        JSON.stringify(result),
      );
      return {
        exitCode: outcome === 'environment-failure' ? 1 : 0,
        timedOut: false,
      };
    },
  };
  return { config, boundaries, state };
}
