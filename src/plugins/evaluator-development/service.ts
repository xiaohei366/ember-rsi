import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type {
  JsonObject,
  Operation,
  RuntimeContext,
} from '../../contracts/index.js';
import { parseFileTree } from '../../contracts/index.js';
import {
  validateMeasurement,
  measurementItemsSchema,
  evaluationFeedbackSchema,
} from '../../contracts/models/measurement.js';
import {
  developmentContract,
  type DevelopmentInput,
  type DevelopmentOutput,
  type DevelopmentOutcome,
} from '../../contracts/plugin-types/development.js';
import { digest, object, string } from '../../shared/json.js';
import { parseConfig, validate } from '../../shared/schema.js';
import type { EvaluatorRunner } from '../shared/evaluator-adapter/sdk.js';
import { sdkRunner } from '../shared/evaluator-adapter/sdk.js';
import { configSchema, type DevelopmentConfig } from './schema.js';
import {
  runAcceptanceProcess,
  type AcceptanceRequest,
  type AcceptanceProcessResult,
} from './process.js';
import {
  collectDelivery,
  contained,
  executeSdk,
  preflightPassed,
  sdkConfiguration,
  sdkRecords,
  sdkRunMatches,
  WORKBUDDY_TASK,
  type StageResult,
} from './sdk.js';

export interface DevelopmentBoundaries {
  runSdk?: EvaluatorRunner;
  runAcceptance?: (
    request: AcceptanceRequest,
  ) => Promise<AcceptanceProcessResult>;
}
interface PreparedExperiment {
  directory: string;
  baselineRef: string;
  bundleRef: string;
  taskPackageRef: string;
  preflightRef: string;
  ready: boolean;
}

function developmentCost(stage: StageResult): JsonObject {
  const records = sdkRecords(stage.raw);
  const fields = ['inputTokens', 'outputTokens', 'totalTokens'];
  const durations = records.map(
    (record) => object(record.phaseDurationMs ?? {}).solve,
  );
  const durationMs =
    durations.length &&
    durations.every((duration) => typeof duration === 'number' && duration >= 0)
      ? durations.reduce<number>((sum, duration) => sum + Number(duration), 0)
      : null;
  const result: JsonObject = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    modelCalls: null,
    durationMs,
    complete: records.length > 0,
  };
  for (const field of fields) {
    let known = 0,
      count = 0;
    for (const record of records) {
      const accounting = object(record.accounting ?? {});
      const usage = object(
        accounting.usage ?? object(record.solve ?? {}).usage ?? {},
      );
      const amount = usage[field];
      if (
        typeof amount === 'number' &&
        Number.isSafeInteger(amount) &&
        amount >= 0
      ) {
        known += amount;
        count++;
      }
      if (accounting.complete !== true) result.complete = false;
    }
    result[field] = count ? known : null;
    if (count !== records.length) result.complete = false;
  }
  return result;
}

function developmentResult(
  stage: StageResult,
  taskId: string,
): {
  outcome: DevelopmentOutcome;
  issues: string[];
} {
  if (stage.timedOut)
    return {
      outcome: 'uncertain-failure',
      issues: [
        'Development exceeded its execution limit; timeout alone does not identify the cause.',
      ],
    };
  const records = sdkRecords(stage.raw);
  if (!sdkRunMatches(stage.raw, taskId))
    return {
      outcome: 'uncertain-failure',
      issues: [
        'Development records do not confirm the fixed selected task identity or complete collection.',
      ],
    };
  const errors = records.flatMap((record) =>
    Array.isArray(record.errors)
      ? record.errors.map((error) => object(error))
      : [],
  );
  const environmental = errors.filter(
    (error) =>
      typeof error.code === 'string' &&
      /^(ENV_|MODEL_AUTH|MODEL_QUOTA|NETWORK_|DATA_FETCH|SCHEDULER_|CLEANUP_)/.test(
        error.code,
      ),
  );
  const issues = errors.map(
    (error) =>
      `${String(error.phase)}: ${String(error.code)}: ${String(error.message)}`,
  );
  if (stage.diagnostic) issues.push(String(stage.diagnostic.message));
  if (environmental.length) return { outcome: 'environment-failure', issues };
  const complete =
    object(object(stage.raw.snapshot ?? {}).run ?? {}).status === 'completed';
  if (!complete || records.length !== 1 || errors.length || stage.diagnostic)
    return {
      outcome: 'uncertain-failure',
      issues: issues.length
        ? issues
        : ['Development has no confirmed complete execution record.'],
    };
  if (records[0].executionStatus !== 'completed')
    return {
      outcome: 'uncertain-failure',
      issues: ['Development execution did not complete.'],
    };
  if (
    records[0].verdict === null ||
    records[0].verdict === undefined ||
    records[0].scoreStatus !== 'valid'
  )
    return {
      outcome: 'uncertain-failure',
      issues: ['Development has no valid local verifier result.'],
    };
  if (object(records[0].verdict ?? {}).passed === false)
    return {
      outcome: 'development-failure',
      issues: [
        'The fixed local development verifier reported unmet requirements.',
      ],
    };
  return { outcome: 'automatic-pass', issues: [] };
}

async function validatePreparedTask(
  config: DevelopmentConfig,
  taskPackage: string,
  signal: AbortSignal,
): Promise<void> {
  const sdk = await import('ember-evaluator');
  const native = object(config.development.sdk.benchmark);
  if (native.name !== 'harbor')
    throw new Error(
      'development.sdk.benchmark.name must be harbor for the prepared local task package',
    );
  const harbor = sdk.parseHarborConfig({
    ...object(native.config ?? {}),
    source: { kind: 'local', path: taskPackage },
  });
  const task = await sdk.loadGenericHarborTask(
    contained(taskPackage, config.development.taskDirectory),
    taskPackage,
    config.development.taskId,
    harbor,
    {
      async prepare() {
        return {};
      },
      async verify() {
        throw new Error('Task inspection does not execute verification');
      },
    },
    signal,
  );
  if (task.solveEnv.network !== 'model-api')
    throw new Error(
      'Development task must declare agent.network_mode = no-network (SDK model-api gateway only)',
    );
  if (task.input.mcpServers?.length || task.input.skillsDirectories?.length)
    throw new Error(
      'Development task cannot supply MCP services or a second task-owned skill version',
    );
  const environment = config.development.sdk.environment;
  if (
    environment !== 'docker' &&
    (typeof environment !== 'object' ||
      environment === null ||
      Array.isArray(environment) ||
      environment.name !== 'docker')
  )
    throw new Error(
      'Development requires the Docker environment to enforce model-only networking',
    );
  if (!task.artifactCollection && !task.transfer)
    throw new Error('Development task must declare delivery artifacts');
}

async function fileChanges(
  context: RuntimeContext,
  baselineRef: string,
  sourceRef: string,
  pluginDirectory: string,
): Promise<JsonObject> {
  const baseline = parseFileTree(await context.artifacts.readJson(baselineRef));
  const source = parseFileTree(await context.artifacts.readJson(sourceRef));
  const before = new Map(baseline.files.map((file) => [file.path, file]));
  const after = new Map(source.files.map((file) => [file.path, file]));
  const files = [...new Set([...before.keys(), ...after.keys()])]
    .filter(
      (path) =>
        digest(before.get(path) ?? null) !== digest(after.get(path) ?? null),
    )
    .sort();
  const forbidden = files.filter((path) => {
    if (path.startsWith('.gepa/input/')) return true;
    if (path.startsWith('.gepa/')) return false;
    if (
      !before.has(path) &&
      (path.startsWith('src/plugins/') ||
        path.startsWith('src/policies/') ||
        path.startsWith('src/contracts/plugin-types/') ||
        /^tests\/unit\/gepa[^/]*\.test\.(ts|mjs)$/.test(path))
    )
      return false;
    return true;
  });
  const { parseDocument } = await import('yaml');
  const policyFiles = new Set(
    files.filter((path) => path.startsWith('src/policies/')),
  );
  for (const path of files.filter((path) => /\.ya?ml$/.test(path))) {
    const file = after.get(path);
    if (!file) continue;
    const document = parseDocument(
      Buffer.from(file.base64, 'base64').toString('utf8'),
      { uniqueKeys: true },
    );
    if (!document.errors.length) {
      try {
        const value: unknown = document.toJS({ maxAliasCount: 0 });
        if (
          value &&
          typeof value === 'object' &&
          'schemaVersion' in value &&
          value.schemaVersion === 'rsi.policy/v1'
        )
          policyFiles.add(path);
      } catch {
        /* Invalid delivery YAML is handled by independent loading, not this file inventory. */
      }
    }
  }
  const pluginFiles = new Set(
    files.filter(
      (path) =>
        path.startsWith('src/plugins/') ||
        (path.startsWith(`${pluginDirectory}/`) &&
          /\.(?:mjs|js|ts)$/.test(path)),
    ),
  );
  return {
    files: files.map((path) => ({
      path,
      category: policyFiles.has(path)
        ? 'policy'
        : pluginFiles.has(path)
          ? 'plugin'
          : path.startsWith('tests/')
            ? 'self-test'
            : 'run-configuration',
    })),
    policies: [...policyFiles],
    plugins: [...pluginFiles],
    forbidden,
    explanation: `Compared retained delivery with the frozen baseline: ${policyFiles.size} Policy files and ${pluginFiles.size} extension modules. Paths are categorized below; implementation logic requires human review.`,
  };
}

export const acceptanceValidationVersion = 'rsi.gepa-acceptance/v2';

/** Correlate business progress with Manager facts without prescribing Policy shape. */
function acceptanceRoundEvidence(
  result: JsonObject,
  attemptId: string,
  measurements: JsonObject[],
): JsonObject {
  const experiment = object(result.experiment);
  const initial = string(
    object(experiment.application).initialCandidateRef,
    'Acceptance initial candidate',
  );
  if (!Array.isArray(result.calls) || !Array.isArray(result.candidates))
    throw new Error(
      'Independent acceptance requires captured Manager calls and candidate facts',
    );
  const calls = new Map<string, JsonObject>();
  for (const raw of result.calls) {
    const call = object(raw),
      id = string(call.callId);
    if (call.experimentId !== attemptId || calls.has(id))
      throw new Error('Acceptance call ownership or identity mismatch');
    calls.set(id, call);
  }
  const candidates = new Map<string, JsonObject>();
  for (const raw of result.candidates) {
    const candidate = object(raw),
      ref = string(candidate.ref);
    if (candidate.experimentId !== attemptId || candidates.has(ref))
      throw new Error('Acceptance candidate ownership or identity mismatch');
    string(candidate.artifactRef);
    candidates.set(ref, candidate);
  }
  const baseline = candidates.get(initial);
  if (!baseline || baseline.parentRef !== null)
    throw new Error('Acceptance has no owned initial candidate fact');
  const succeeded = (call: JsonObject): boolean => call.status === 'succeeded';
  const application = (call: JsonObject): boolean =>
    call.pluginId === 'application.agentbundle' &&
    call.contractId === 'contract.application';
  const initialized = [...calls.values()].some(
    (call) =>
      succeeded(call) &&
      application(call) &&
      object(call.input).action === 'initialize' &&
      object(call.output).action === 'initialize' &&
      object(call.output).initialCandidateRef === initial,
  );
  if (!initialized)
    throw new Error(
      'Acceptance initial candidate has no successful Application initialize receipt',
    );
  const evaluated = new Map<
    string,
    { measurement: JsonObject; call: JsonObject }[]
  >();
  for (const measurement of measurements) {
    const call = calls.get(string(measurement.callId));
    if (
      !call ||
      !succeeded(call) ||
      call.pluginId !== 'evaluator.agentbench' ||
      call.contractId !== 'contract.agentbench'
    )
      continue;
    const input = object(call.input),
      output = object(call.output);
    if (
      input.candidateRef !== measurement.candidateRef ||
      output.measurementRef !== measurement.ref ||
      !Array.isArray(input.taskIds) ||
      input.taskIds.length !== 1 ||
      input.taskIds[0] !== WORKBUDDY_TASK ||
      !candidates.has(string(measurement.candidateRef))
    )
      continue;
    const key = string(measurement.candidateRef);
    evaluated.set(key, [...(evaluated.get(key) ?? []), { measurement, call }]);
  }
  const baselineRuns = evaluated.get(initial);
  if (!baselineRuns?.length)
    throw new Error(
      'The selected WorkBuddy task has no baseline Measurement bound to its actual SDK evaluator call',
    );
  const time = (call: JsonObject, key: string): number => {
    const value = Date.parse(string(call[key], `Acceptance call.${key}`));
    if (!Number.isFinite(value))
      throw new Error(`Invalid acceptance call.${key}`);
    return value;
  };
  const descendsFromBaseline = (ref: string): boolean => {
    const seen = new Set<string>();
    while (ref !== initial) {
      if (seen.has(ref)) return false;
      seen.add(ref);
      const candidate = candidates.get(ref);
      if (!candidate || typeof candidate.parentRef !== 'string') return false;
      ref = candidate.parentRef;
    }
    return true;
  };
  for (const commit of calls.values()) {
    if (!succeeded(commit) || !application(commit)) continue;
    const input = object(commit.input),
      output = object(commit.output);
    if (
      input.action !== 'commit' ||
      output.action !== 'commit' ||
      output.status !== 'created' ||
      typeof output.candidateRef !== 'string' ||
      typeof output.diffRef !== 'string'
    )
      continue;
    const child = candidates.get(output.candidateRef);
    const parent =
      typeof input.parentCandidateRef === 'string'
        ? candidates.get(input.parentCandidateRef)
        : undefined;
    if (
      !child ||
      !parent ||
      child.ref === initial ||
      child.parentRef !== parent.ref ||
      child.artifactRef === parent.artifactRef ||
      !descendsFromBaseline(string(child.ref))
    )
      continue;
    const owner =
      commit.parentCallId === 'root'
        ? null
        : calls.get(string(commit.parentCallId));
    if (commit.parentCallId !== 'root' && (!owner || !succeeded(owner)))
      continue;
    const baselineRun = baselineRuns.find(
      (entry) => time(entry.call, 'finishedAt') <= time(commit, 'startedAt'),
    );
    const childRun = evaluated
      .get(string(child.ref))
      ?.find(
        (entry) => time(commit, 'finishedAt') <= time(entry.call, 'startedAt'),
      );
    if (baselineRun && childRun)
      return {
        kind: 'candidate-lineage',
        baselineCandidateRef: initial,
        baselineMeasurementRef: baselineRun.measurement.ref!,
        commitCallId: commit.callId!,
        proposalCallId: owner?.callId ?? null,
        candidateRef: child.ref!,
        candidateMeasurementRef: childRun.measurement.ref!,
      };
  }
  // A real no-change proposal may finish either a plugin-owned round or a
  // Policy-owned round. An empty loop plus a baseline alone is insufficient.
  const boundaries = Array.isArray(result.boundaries)
    ? result.boundaries.map((raw) => object(raw))
    : [];
  for (const proposal of calls.values()) {
    if (!succeeded(proposal) || proposal.contractId !== 'contract.proposer')
      continue;
    const input = object(proposal.input),
      output = object(proposal.output);
    if (
      output.status !== 'no-change' ||
      output.diffRef !== null ||
      output.candidateRef !== input.parent ||
      typeof output.candidateRef !== 'string' ||
      !evaluated.has(output.candidateRef)
    )
      continue;
    const previous = evaluated
      .get(output.candidateRef)
      ?.find(
        (entry) =>
          time(entry.call, 'finishedAt') <= time(proposal, 'startedAt'),
      );
    if (!previous) continue;
    if (
      proposal.parentCallId === 'root' &&
      typeof proposal.path === 'string' &&
      proposal.path.startsWith('steps/')
    )
      return {
        kind: 'policy-no-change',
        baselineCandidateRef: initial,
        baselineMeasurementRef: previous.measurement.ref!,
        proposalCallId: proposal.callId!,
      };
    let call: JsonObject | undefined = proposal;
    const seen = new Set<string>();
    while (call && !seen.has(string(call.callId))) {
      seen.add(string(call.callId));
      if (
        call !== proposal &&
        succeeded(call) &&
        call.output !== null &&
        typeof call.output === 'object' &&
        !Array.isArray(call.output)
      ) {
        const rounds = object(call.output).completedRounds;
        if (
          typeof rounds === 'number' &&
          Number.isInteger(rounds) &&
          rounds >= 1
        )
          return {
            kind: 'plugin-no-change',
            baselineCandidateRef: initial,
            baselineMeasurementRef: previous.measurement.ref!,
            proposalCallId: proposal.callId!,
            ownerCallId: call.callId!,
          };
      }
      const boundary = boundaries.find(
        (entry) =>
          entry.experimentId === attemptId &&
          entry.policyScopeId === 'root' &&
          entry.boundary === 'iteration-completed' &&
          typeof entry.stepPath === 'string' &&
          /^steps\/.+\/iteration-\d+$/.test(entry.stepPath) &&
          typeof call?.path === 'string' &&
          call.path.startsWith(`${entry.stepPath}/`),
      );
      if (boundary)
        return {
          kind: 'policy-loop-no-change',
          baselineCandidateRef: initial,
          baselineMeasurementRef: baselineRuns[0].measurement.ref!,
          proposalCallId: proposal.callId!,
          boundaryPath: boundary.stepPath!,
        };
      call =
        typeof call.parentCallId === 'string'
          ? calls.get(call.parentCallId)
          : undefined;
    }
  }
  throw new Error(
    'Independent acceptance has no correlated completed GEPA proposal/commit/evaluation round',
  );
}

export async function validateAcceptance(
  directory: string,
  attemptId: string,
): Promise<JsonObject> {
  const result = object(
    JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')),
  );
  if (result.attemptId !== attemptId)
    throw new Error('Acceptance attempt identity mismatch');
  const experiment = object(result.experiment);
  const target = object(object(experiment.application ?? {}).target ?? {});
  if (
    !Array.isArray(target.entries) ||
    target.entries.length !== 1 ||
    object(target.entries[0]).path !==
      'plugins/office-base/prompts/office-discipline.md' ||
    object(target.entries[0]).kind !== 'file' ||
    JSON.stringify(object(target.entries[0]).changes) !==
      JSON.stringify(['modify'])
  )
    throw new Error(
      'Inner GEPA Application must authorize only the fixed Office discipline prompt',
    );
  const output = object(experiment.output ?? {});
  if (
    experiment.id !== attemptId ||
    experiment.status !== 'succeeded' ||
    typeof output.completedRounds !== 'number' ||
    !Number.isInteger(output.completedRounds) ||
    output.completedRounds < 1
  )
    throw new Error(
      'Independent GEPA execution has no normally completed minimal round',
    );
  if (!Array.isArray(result.measurements))
    throw new Error('Independent acceptance has no Measurement records');
  let executed = false;
  const measured: JsonObject[] = [];
  for (const raw of result.measurements) {
    const entry = object(raw);
    validateMeasurement(entry.measurement);
    const measurement = entry.measurement;
    if (
      measurement.experimentId !== attemptId ||
      measurement.status !== 'succeeded' ||
      measurement.evaluator.pluginId !== 'evaluator.agentbench'
    )
      continue;
    validate(
      measurementItemsSchema,
      entry.items,
      'Acceptance Measurement items',
    );
    const items = object(entry.items).items;
    if (!Array.isArray(items)) continue;
    if (
      items.some(
        (rawItem) => object(object(rawItem).subject).id !== WORKBUDDY_TASK,
      )
    )
      throw new Error(
        'Independent acceptance evaluated tasks outside the fixed WorkBuddy task',
      );
    const validTask = items.some((rawItem) => {
      const item = object(rawItem);
      if (
        object(item.subject).id !== WORKBUDDY_TASK ||
        !['succeeded', 'unknown'].includes(String(item.status)) ||
        item.evaluation === null
      )
        return false;
      const descriptor = object(item.evaluation);
      if (
        descriptor.schemaId !== 'rsi.evaluation-feedback/v1' ||
        descriptor.schemaDigest !== digest(evaluationFeedbackSchema)
      )
        return false;
      const evaluations = Array.isArray(entry.evaluations)
        ? entry.evaluations.map((raw) => object(raw))
        : [];
      const evidence = evaluations.find(
        (value) =>
          value.itemId === item.id &&
          value.artifactRef === descriptor.artifactRef,
      );
      if (!evidence) return false;
      validate(
        evaluationFeedbackSchema,
        evidence.feedback,
        'Acceptance evaluation feedback',
      );
      const feedback = object(evidence.feedback),
        native = object(evidence.nativeRecord),
        key = object(native.key);
      return (
        feedback.itemId === item.id &&
        feedback.executionStatus === 'completed' &&
        feedback.scoreStatus === 'valid' &&
        evidence.nativeRecordRef === object(feedback.source).artifactRef &&
        key.taskId === WORKBUDDY_TASK &&
        key.attemptId === feedback.attemptId &&
        native.executionStatus === 'completed' &&
        native.scoreStatus === 'valid' &&
        native.cleanupStatus === 'cleaned'
      );
    });
    executed ||= validTask;
    if (validTask) measured.push(measurement);
  }
  if (!executed)
    throw new Error(
      'The selected WorkBuddy task has no actual successful execution/evaluation record',
    );
  return {
    ...result,
    validationVersion: acceptanceValidationVersion,
    roundEvidence: acceptanceRoundEvidence(result, attemptId, measured),
  };
}

/** Owns preparation and reports; only SDK execution and the acceptance process are replaceable boundaries. */
export async function createDevelopmentEvaluator(
  rawConfig: DevelopmentConfig,
  _services: RuntimeContext,
  boundaries: DevelopmentBoundaries = {},
): Promise<Operation<DevelopmentInput, DevelopmentOutput>> {
  const config = parseConfig<DevelopmentConfig>(
    configSchema,
    rawConfig,
    'Development evaluator config',
  );
  const prepared = new Map<string, PreparedExperiment>();
  const reports = new Set<string>();
  const sdk = boundaries.runSdk ?? sdkRunner;
  const accept = boundaries.runAcceptance ?? runAcceptanceProcess;
  return {
    async execute(input, context): Promise<DevelopmentOutput> {
      validate(developmentContract.input_schema, input, 'Development input');
      context.signal.throwIfAborted();
      const candidate = await context.readCandidate(input.candidateRef);
      if (input.action === 'export') {
        if (!reports.has(input.reportRef))
          throw new Error(
            'Result export requires a report produced by this live evaluator',
          );
        const report = object(
          await context.artifacts.readJson(input.reportRef),
        );
        const review = object(
          await context.artifacts.readJson(input.reviewRef),
        );
        if (
          report.experimentId !== context.experimentId ||
          report.candidateRef !== input.candidateRef ||
          report.outcome !== 'automatic-pass' ||
          review.action !== 'accept' ||
          review.context !== 'implementation' ||
          review.experimentId !== context.experimentId ||
          review.automaticAccepted !== true ||
          review.candidateRef !== input.candidateRef ||
          review.attemptId !== report.attemptId ||
          review.reportRef !== input.reportRef ||
          report.skillArtifactRef !== candidate.artifactRef
        )
          throw new Error(
            'Result export requires automatic acceptance and the bound human acceptance of this exact implementation/skill pair',
          );
        const packageDirectory = join(
          context.dataDirectory,
          'experiments',
          context.experimentId,
          'result-packages',
          string(report.attemptId),
        );
        await mkdir(packageDirectory, { recursive: true });
        await context.artifacts.materialize(
          string(object(report.development).sourceRef),
          join(packageDirectory, 'implementation'),
        );
        await context.artifacts.materialize(
          candidate.artifactRef,
          join(packageDirectory, 'skill'),
        );
        context.signal.throwIfAborted();
        const summary = {
          schemaVersion: 'rsi.development-result/v1',
          outcome: 'accepted',
          experimentId: context.experimentId,
          candidateRef: candidate.ref,
          attemptId: report.attemptId,
          reportRef: input.reportRef,
          reviewRef: input.reviewRef,
          skillArtifactRef: candidate.artifactRef,
          sourceRef: object(report.development).sourceRef,
          packageDirectory,
        };
        await writeFile(
          join(packageDirectory, 'result.json'),
          JSON.stringify(summary, null, 2) + '\n',
          { flag: 'wx' },
        );
        await writeFile(
          join(packageDirectory, 'report.json'),
          JSON.stringify(report, null, 2) + '\n',
          { flag: 'wx' },
        );
        await writeFile(
          join(packageDirectory, 'review.json'),
          JSON.stringify(review, null, 2) + '\n',
          { flag: 'wx' },
        );
        await writeFile(
          join(packageDirectory, 'README.md'),
          `# Accepted development result\n\nImplementation: [implementation](implementation/); runnable [Recipe](implementation/${config.acceptance.recipePath}). Exact supplied skill and fixed support: [skill](skill/).\n\nEvidence: [report](report.json) (${input.reportRef}); [human acceptance](review.json) (${input.reviewRef}).\n\nThis package is retained for explicit later application.\n`,
          { flag: 'wx' },
        );
        const packageRef = await context.artifacts.capture(packageDirectory);
        context.signal.throwIfAborted();
        return { action: 'export', packageRef };
      }
      if (input.action === 'preflight') {
        if (prepared.has(context.experimentId))
          throw new Error(
            'Preflight is already frozen for this live experiment',
          );
        const directory = join(
          context.dataDirectory,
          'experiments',
          context.experimentId,
          'development',
        );
        const baselineToData = relative(
          resolve(config.development.baselineDirectory),
          resolve(context.dataDirectory),
        );
        if (
          !baselineToData ||
          (!isAbsolute(baselineToData) &&
            baselineToData !== '..' &&
            !baselineToData.startsWith(`..${sep}`))
        )
          throw new Error(
            'development.baselineDirectory must be a clean prepared snapshot outside the Runtime data tree',
          );
        await mkdir(directory, { recursive: true });
        const baselineRef = await context.artifacts.capture(
          config.development.baselineDirectory,
        );
        const bundleRef = await context.artifacts.capture(
          config.development.bundle,
        );
        const fixedBundle = parseFileTree(
          await context.artifacts.readJson(bundleRef),
        );
        if (
          fixedBundle.files.some((file) =>
            /(^|\/)skills\/ember-rsi\//.test(file.path),
          )
        )
          throw new Error(
            'Development Bundle must not embed a stale ember-rsi skill',
          );
        const taskPackageRef = await context.artifacts.capture(
          config.development.taskPackage,
        );
        const preflightBundleRef = await context.artifacts.capture(
          config.preflight.bundle,
        );
        await context.artifacts.materialize(
          taskPackageRef,
          join(directory, 'fixed-task'),
        );
        await context.artifacts.materialize(
          preflightBundleRef,
          join(directory, 'preflight-bundle'),
        );
        await validatePreparedTask(
          config,
          join(directory, 'fixed-task'),
          context.signal,
        );
        const embeddedBaseline = contained(
          join(directory, 'fixed-task'),
          `${config.development.taskDirectory}/environment/repository`,
        );
        if ((await context.artifacts.capture(embeddedBaseline)) !== baselineRef)
          throw new Error(
            'Prepared task environment/repository does not match the frozen repository baseline',
          );
        const native = sdkConfiguration(
          config.preflight.sdk,
          join(directory, 'preflight-bundle'),
          WORKBUDDY_TASK,
          join(directory, 'preflight', 'sdk'),
          config.acceptanceTimeoutMs!,
        );
        const stage = await executeSdk(
          native,
          context,
          config.acceptanceTimeoutMs!,
          sdk,
        );
        const preflightRef = await context.artifacts.putJson({
          schemaVersion: 'rsi.development-preflight/v1',
          candidateRef: candidate.ref,
          baselineRef,
          bundleRef,
          taskPackageRef,
          preflightBundleRef,
          rolesDigest: digest(config),
          ...stage,
          ready: !stage.timedOut && preflightPassed(stage.raw),
        });
        const ready = !stage.timedOut && preflightPassed(stage.raw);
        prepared.set(context.experimentId, {
          directory,
          baselineRef,
          bundleRef,
          taskPackageRef,
          preflightRef,
          ready,
        });
        context.signal.throwIfAborted();
        return { action: 'preflight', ready, reportRef: preflightRef };
      }
      const fixed = prepared.get(context.experimentId);
      if (!fixed?.ready)
        throw new Error(
          'Development requires a successful preflight in this live experiment',
        );
      const attemptId = `development-${input.attempt}-${randomUUID()}`;
      const directory = join(fixed.directory, attemptId);
      await mkdir(directory);
      const skillDirectory = join(directory, 'skill');
      const bundleDirectory = join(directory, 'bundle');
      const taskPackage = join(directory, 'task');
      await context.artifacts.materialize(
        candidate.artifactRef,
        skillDirectory,
      );
      await context.artifacts.materialize(fixed.bundleRef, bundleDirectory);
      await context.artifacts.materialize(fixed.taskPackageRef, taskPackage);
      const skillPath = contained(skillDirectory, 'skills/ember-rsi');
      const skillContent = await readFile(join(skillPath, 'SKILL.md'), 'utf8');
      const pluginRoot = posix.dirname(
        posix.dirname(config.development.skillPrompt),
      );
      // DSH installs a physical copy of each declared plugin, so companion skill
      // files must live inside that plugin rather than beside Bundle plugins.
      const targetSkill = contained(
        bundleDirectory,
        `${pluginRoot}/skills/ember-rsi`,
      );
      // A second version would defeat authoritative delivery. Preparation must leave this destination empty.
      try {
        await lstat(targetSkill);
        throw new Error(
          'Development Bundle must not embed a stale ember-rsi skill',
        );
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
      await cp(skillPath, targetSkill, { recursive: true });
      const prompt = contained(bundleDirectory, config.development.skillPrompt);
      await writeFile(
        prompt,
        (await readFile(prompt, 'utf8')) +
          `\n\n## Authoritative ember-rsi skill for this attempt\n\n${skillContent}\n\nRead references and fixed assets on demand from this development plugin's skills/ember-rsi directory.\n`,
      );
      const instruction = contained(
        taskPackage,
        `${config.development.taskDirectory}/instruction.md`,
      );
      await writeFile(
        instruction,
        (await readFile(instruction, 'utf8')) +
          `\n\n## Fixed acceptance issues for attempt ${input.attempt}\n\n${input.acceptanceIssues.length ? input.acceptanceIssues.map((issue) => `- ${issue}`).join('\n') : 'No additional human-reported unmet requirements.'}\n`,
      );
      const native = sdkConfiguration(
        config.development.sdk,
        bundleDirectory,
        config.development.taskId,
        join(directory, 'development', 'sdk'),
        config.developmentTimeoutMs!,
      );
      const benchmark = object(native.benchmark);
      benchmark.config = {
        ...object(benchmark.config ?? {}),
        source: { kind: 'local', path: taskPackage },
        cacheDir: join(directory, 'task-cache'),
      };
      const started = Date.now();
      const stage = await executeSdk(
        native,
        context,
        config.developmentTimeoutMs!,
        sdk,
      );
      const cost = developmentCost(stage);
      const executionWallMs = Date.now() - started;
      let { outcome, issues } = developmentResult(
        stage,
        config.development.taskId,
      );
      let sourceDirectory: string | null = null,
        sourceRef: string | null = null;
      let changes: JsonObject = {
        files: [],
        plugins: [],
        policies: [],
        forbidden: [],
        explanation: 'Delivery unavailable; changed files are unknown.',
      };
      try {
        sourceDirectory = await collectDelivery(
          stage.raw,
          join(directory, 'development', 'sdk'),
          join(directory, 'delivery'),
          config.development.deliveryDirectory,
          context.cleanup,
        );
        if (sourceDirectory) {
          sourceRef = await context.artifacts.capture(sourceDirectory);
          changes = await fileChanges(
            context,
            fixed.baselineRef,
            sourceRef,
            config.acceptance.pluginDirectory,
          );
          if (Array.isArray(changes.forbidden) && changes.forbidden.length) {
            outcome = 'development-failure';
            issues.push(
              `Delivery modified unauthorized baseline files: ${changes.forbidden.join(', ')}`,
            );
          }
        } else if (outcome === 'automatic-pass') {
          outcome = 'development-failure';
          issues.push(
            'Development completed without the declared source delivery.',
          );
        }
      } catch (error) {
        outcome = 'uncertain-failure';
        issues.push(
          `Delivery collection: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const developmentRef = await context.artifacts.putJson({
        raw: stage.raw,
        diagnostic: stage.diagnostic,
        timedOut: stage.timedOut,
      });
      const developmentIssues = [...issues];
      const traceRef = await context.artifacts.capture(
        join(directory, 'development'),
      );
      const acceptance: JsonObject = {
        validationVersion: acceptanceValidationVersion,
        status: 'not-run',
        firstResultRef: null,
        evidenceRefs: [],
        issues: [],
      };
      if (outcome === 'automatic-pass' && sourceDirectory) {
        const outputDirectory = join(directory, 'acceptance');
        await mkdir(outputDirectory);
        const timeoutController = new AbortController();
        const timer = setTimeout(
          () =>
            timeoutController.abort(
              new Error('Independent acceptance deadline exceeded'),
            ),
          config.acceptanceTimeoutMs!,
        );
        try {
          const execution = await accept({
            attemptId,
            sourceDirectory,
            recipePath: config.acceptance.recipePath,
            pluginDirectory: config.acceptance.pluginDirectory,
            outputDirectory,
            signal: AbortSignal.any([context.signal, timeoutController.signal]),
          });
          if (execution.timedOut || timeoutController.signal.aborted) {
            acceptance.status = 'timed-out';
            outcome = 'uncertain-failure';
            issues.push('Independent acceptance exceeded its deadline.');
          } else if (execution.exitCode !== 0) {
            acceptance.status = 'failed';
            outcome = 'uncertain-failure';
            issues.push(
              'Independent acceptance process failed; inspect retained framework records and runner log.',
            );
          } else {
            try {
              const verified = await validateAcceptance(
                outputDirectory,
                attemptId,
              );
              acceptance.roundEvidence = verified.roundEvidence!;
              acceptance.status = 'passed';
            } catch (error) {
              acceptance.status = 'failed';
              outcome =
                error instanceof SyntaxError ||
                (error instanceof Error && 'code' in error)
                  ? 'uncertain-failure'
                  : 'development-failure';
              issues.push(
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        } catch (error) {
          acceptance.status = timeoutController.signal.aborted
            ? 'timed-out'
            : 'unknown';
          outcome = 'uncertain-failure';
          issues.push(
            `Independent acceptance: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          clearTimeout(timer);
          acceptance.firstResultRef =
            await context.artifacts.capture(outputDirectory);
          acceptance.evidenceRefs = [acceptance.firstResultRef];
          acceptance.issues = [...issues];
        }
      }
      const report: JsonObject = {
        schemaVersion: 'rsi.development-report/v1',
        experimentId: context.experimentId,
        attempt: input.attempt,
        attemptId,
        candidateRef: candidate.ref,
        skillArtifactRef: candidate.artifactRef,
        skillDirectory,
        sourceDirectory,
        reportDirectory: directory,
        outcome,
        preflightRef: fixed.preflightRef,
        development: {
          status: stage.timedOut
            ? 'timed-out'
            : (sdkRecords(stage.raw)[0]?.executionStatus ?? 'unknown'),
          executionWallMs,
          executionRef: developmentRef,
          sourceRef,
          issues: developmentIssues,
          evidenceRefs: [developmentRef, traceRef],
        },
        acceptance,
        developmentCost: cost,
        issues,
        acceptanceIssues: input.acceptanceIssues,
        changes,
        skillChanges: {
          parentRef: candidate.parentRef,
          candidateRef: candidate.ref,
        },
        evidenceLimitations: [
          'Instruction delivery is recorded; observed use still requires trace review.',
          'One task and one minimal GEPA round do not establish full algorithm correctness or skill generalization.',
        ],
      };
      const reportRef = await context.artifacts.putJson(report);
      reports.add(reportRef);
      await writeFile(
        join(directory, 'report.json'),
        JSON.stringify({ ...report, reportRef }, null, 2) + '\n',
        { flag: 'wx' },
      );
      await writeFile(
        join(directory, 'report.md'),
        `# Development attempt ${input.attempt}\n\nOutcome: ${outcome}.\n\nExact skill: [SKILL.md](skill/skills/ember-rsi/SKILL.md). Retained delivery: ${sourceDirectory ?? 'missing'}.\n\nDevelopment cost: ${JSON.stringify(cost)}. Independent acceptance: ${String(acceptance.status)}.\n\n${issues.map((issue) => `- ${issue}`).join('\n')}\n\nFiles and evidence: [report.json](report.json).\n`,
        { flag: 'wx' },
      );
      context.signal.throwIfAborted();
      return {
        action: 'evaluate',
        attemptId,
        candidateRef: candidate.ref,
        outcome,
        reportRef,
      };
    },
    async dispose(): Promise<void> {
      prepared.clear();
      reports.clear();
    },
  };
}
