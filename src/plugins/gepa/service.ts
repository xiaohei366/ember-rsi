import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type {
  JsonObject,
  JsonValue,
  Operation,
  OperationDefinition,
  RuntimeContext,
} from '../../contracts/index.js';
import type {
  GepaModule,
  GepaOptimizerInput,
  GepaOptimizerOutput,
  GepaSettings,
} from '../../contracts/plugin-types/gepa.js';
import { gepaStateSchema } from '../../contracts/plugin-types/gepa.js';
import { digest, object, string } from '../../shared/json.js';
import { metricDefinitionSchema } from '../../contracts/models/measurement.js';
import { parseConfig, validate } from '../../shared/schema.js';
import {
  Rng,
  addScores,
  ancestry,
  bestCandidate,
  emptyState,
  findMerge,
  mean,
  mergeKey,
  mergePrompts,
  refreshCandidate,
  sampleWithoutReplacement,
  scoresFor,
  selectCandidate,
  stateRngFrom,
  type CandidateRecord,
  type EvaluationOutcome,
  type GepaState,
  type RoundReport,
} from './engine.js';

const proposalSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['proposal', 'rationale'],
  properties: {
    proposal: { type: ['string', 'null'] },
    rationale: { type: 'string' },
    noChange: { type: 'boolean' },
  },
};

const evaluationFeedbackSchema = 'rsi.evaluation-feedback/v1';
function safePath(path: string): string {
  const parts = path.split('/');
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    parts.some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(
      `GEPA module path is not a safe bundle-relative path: ${path}`,
    );
  return path;
}

function moduleMap(modules: readonly GepaModule[]): Map<string, GepaModule> {
  const result = new Map<string, GepaModule>();
  const paths = new Set<string>();
  for (const module of modules) {
    if (result.has(module.id))
      throw new Error(`GEPA module id is duplicated: ${module.id}`);
    if (paths.has(module.path))
      throw new Error(`GEPA module path is duplicated: ${module.path}`);
    paths.add(module.path);
    result.set(module.id, { id: module.id, path: safePath(module.path) });
  }
  return result;
}

function readState(value: JsonObject): GepaState {
  return parseConfig<GepaState>(gepaStateSchema, value, 'GEPA state');
}

function scoresFromEvaluation(
  evaluation: EvaluationOutcome,
  taskIds: readonly string[],
): Record<string, number | null> {
  return Object.fromEntries(
    taskIds.map((task) => [task, evaluation.scores[task] ?? null]),
  );
}

function feedbackText(feedback: JsonObject | null): string {
  if (!feedback) return 'No evaluator feedback was available.';
  const parts: string[] = [];
  if (typeof feedback.executionStatus === 'string')
    parts.push(`executionStatus=${feedback.executionStatus}`);
  if (typeof feedback.scoreStatus === 'string')
    parts.push(`scoreStatus=${feedback.scoreStatus}`);
  if (typeof feedback.passed === 'boolean')
    parts.push(`passed=${feedback.passed}`);
  if (Array.isArray(feedback.diagnostics))
    for (const value of feedback.diagnostics.slice(0, 8)) {
      const entry = object(value);
      const message = typeof entry.message === 'string' ? entry.message : '';
      if (message) parts.push(`diagnostic: ${message.slice(0, 2000)}`);
    }
  if (Array.isArray(feedback.checks))
    for (const value of feedback.checks.slice(0, 12)) {
      const entry = object(value);
      const id = typeof entry.id === 'string' ? entry.id : 'check';
      const status =
        typeof entry.status === 'string' ? entry.status : 'unknown';
      const reason = typeof entry.reason === 'string' ? entry.reason : '';
      parts.push(
        `check ${id}: ${status}${reason ? ` — ${reason.slice(0, 1000)}` : ''}`,
      );
    }
  return parts.length
    ? parts.join('\n')
    : JSON.stringify(feedback).slice(0, 4000);
}

function fileText(value: JsonValue | undefined): string | null {
  if (typeof value !== 'string') return null;
  return value;
}

function evidenceSummary(evaluation: EvaluationOutcome): JsonObject {
  return {
    available: evaluation.evidence !== null,
    measurementRef: evaluation.measurementRef,
    status: evaluation.status,
    files: evaluation.evidence
      ? Object.keys(object(evaluation.evidence.files))
      : [],
    error: evaluation.error,
  };
}

async function evaluateCandidate(
  ctx: RuntimeContext,
  settings: GepaSettings,
  candidateRef: string,
  taskIds: string[],
  purpose: string,
  round: number,
  refs: Record<string, string | null>,
): Promise<EvaluationOutcome> {
  ctx.signal.throwIfAborted();
  if (!taskIds.length)
    return {
      measurementRef: null,
      comparisonKey: null,
      itemComparisonKeys: {},
      scoreDefinitionRefs: {},
      status: 'unknown',
      scores: {},
      feedback: {},
      scoreReasons: {},
      evidence: null,
      error: 'No task rollouts were requested',
      rollouts: 0,
      reused: false,
    };
  const refKey = digest({ candidateRef, taskIds: [...taskIds].sort() });
  const priorRef = refs[refKey] ?? null;
  const expectedCallId =
    'call-' +
    digest({
      experiment: ctx.experimentId,
      bindingId: settings.evaluatorBinding,
      path: ctx.callId,
      input: { candidateRef, taskIds },
    }).slice(0, 32);
  const scope = ctx.extend({
    scope: {
      id: `gepa-${purpose}-${round}-${digest({ candidateRef, taskIds }).slice(0, 16)}`,
      signal: ctx.signal,
      limits: {},
    },
  });
  let measurementRef: string | null = null;
  let callError: string | null = null;
  try {
    const output = object(
      await scope.invoke(settings.evaluatorBinding, { candidateRef, taskIds }),
    );
    measurementRef = string(output.measurementRef);
  } catch (error) {
    throwIfCancelled(ctx, error);
    callError = error instanceof Error ? error.message : String(error);
    if (
      error &&
      typeof error === 'object' &&
      'measurementRef' in error &&
      typeof error.measurementRef === 'string'
    )
      measurementRef = error.measurementRef;
  }
  const outcome: EvaluationOutcome = {
    measurementRef,
    comparisonKey: null,
    itemComparisonKeys: {},
    scoreDefinitionRefs: {},
    status: 'unknown',
    scores: {},
    feedback: {},
    scoreReasons: {},
    evidence: null,
    error: callError,
    rollouts: taskIds.length,
    reused: false,
  };
  if (!measurementRef) return outcome;
  refs[refKey] = measurementRef;
  let measurement: JsonObject;
  try {
    measurement = await ctx.readMeasurement(measurementRef);
  } catch (error) {
    throwIfCancelled(ctx, error);
    outcome.error = error instanceof Error ? error.message : String(error);
    return outcome;
  }
  // A receipt replay returns the same Measurement identity. A new execution in
  // the same plugin step owns the expected nested call identity.
  outcome.reused =
    (priorRef !== null && priorRef === measurementRef) ||
    measurement.callId !== expectedCallId;
  if (outcome.reused) outcome.rollouts = 0;
  outcome.status =
    typeof measurement.status === 'string' ? measurement.status : 'unknown';
  if (outcome.status === 'cancelled')
    throw Object.assign(new Error('GEPA evaluation was cancelled'), {
      status: 'cancelled',
      measurementRef,
    });
  outcome.comparisonKey =
    typeof measurement.comparisonKey === 'string' && measurement.comparisonKey
      ? measurement.comparisonKey
      : null;
  let items: JsonObject[] = [];
  try {
    const catalog = object(
      await ctx.artifacts.readJson(string(measurement.itemsRef)),
    );
    items = Array.isArray(catalog.items)
      ? catalog.items.map((value) => object(value))
      : [];
  } catch (error) {
    throwIfCancelled(ctx, error);
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  const measurementCoverage =
    typeof measurement.coverage === 'string' ? measurement.coverage : 'unknown';
  const executionSucceeded =
    outcome.status === 'succeeded' &&
    (measurementCoverage === 'complete' || measurementCoverage === 'partial');
  for (const task of taskIds) {
    const item = items.find((entry) => entry.id === task);
    outcome.itemComparisonKeys[task] =
      item && typeof item.comparisonKey === 'string' && item.comparisonKey
        ? item.comparisonKey
        : null;
    const itemCoverage =
      item && typeof item.coverage === 'string' ? item.coverage : 'unknown';
    const itemUsable =
      item && item.status === 'succeeded' && itemCoverage === 'complete';
    if (!item || !executionSucceeded || !itemUsable) {
      outcome.scores[task] = null;
      outcome.feedback[task] = null;
      outcome.scoreReasons[task] = !item
        ? 'The evaluator did not report an item for this task'
        : `Execution status was ${String(item.status ?? 'unknown')}, item coverage was ${itemCoverage}, and measurement status/coverage was ${outcome.status}/${measurementCoverage}`;
      continue;
    }
    const metrics = object(item.metrics ?? {});
    const metric = metrics.score === undefined ? null : object(metrics.score);
    const definitionRef =
      metric && typeof metric.definitionRef === 'string'
        ? metric.definitionRef
        : null;
    outcome.scoreDefinitionRefs[task] = definitionRef;
    const scalar =
      metric &&
      metric.status === 'available' &&
      metric.value !== null &&
      typeof metric.value === 'object' &&
      !Array.isArray(metric.value) &&
      object(metric.value).kind === 'scalar'
        ? object(metric.value).value
        : undefined;
    let definitionValid = false;
    if (definitionRef !== null) {
      try {
        const definition = await ctx.artifacts.readJson(definitionRef);
        validate(metricDefinitionSchema, definition, 'GEPA score definition');
        const spec = object(definition);
        definitionValid = spec.id === 'score' && spec.valueKind === 'scalar';
      } catch (error) {
        throwIfCancelled(ctx, error);
      }
    }
    if (
      typeof scalar === 'number' &&
      Number.isFinite(scalar) &&
      definitionValid &&
      outcome.comparisonKey !== null &&
      outcome.itemComparisonKeys[task] !== null
    ) {
      outcome.scores[task] = scalar;
      outcome.scoreReasons[task] = 'valid';
    } else {
      outcome.scores[task] = null;
      outcome.scoreReasons[task] = !definitionValid
        ? 'A valid scalar score definition was not available'
        : outcome.comparisonKey === null ||
            outcome.itemComparisonKeys[task] === null
          ? 'Evaluation comparison conditions were unavailable'
          : metric && typeof metric.reason === 'string'
            ? metric.reason
            : 'A valid scalar score was not available';
    }
    const evaluation =
      item.evaluation === null || item.evaluation === undefined
        ? null
        : object(item.evaluation);
    if (evaluation && typeof evaluation.artifactRef === 'string') {
      try {
        const feedback = object(
          await ctx.artifacts.readJson(evaluation.artifactRef),
        );
        outcome.feedback[task] =
          feedback.schemaVersion === evaluationFeedbackSchema ? feedback : null;
      } catch {
        ctx.signal.throwIfAborted();
        outcome.feedback[task] = null;
      }
    } else outcome.feedback[task] = null;
  }
  try {
    const projection = object(
      await ctx.readEvidence([measurementRef], {
        format: 'files',
        view: 'execution',
        maxBytes: settings.maxEvidenceBytes,
      }),
    );
    const files = object(projection.files ?? {});
    outcome.evidence = {
      available: true,
      files,
      measurements: Array.isArray(projection.measurements)
        ? projection.measurements
        : [],
    };
  } catch (error) {
    throwIfCancelled(ctx, error);
    outcome.evidence = {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      files: {},
      measurements: [],
    };
    if (!outcome.error)
      outcome.error = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}

function throwIfCancelled(context: RuntimeContext, error: unknown): void {
  context.signal.throwIfAborted();
  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    error.status === 'cancelled'
  )
    throw error;
}

function comparisonFailure(
  evaluations: readonly EvaluationOutcome[],
  tasks: readonly string[],
): string | null {
  const first = evaluations[0];
  if (!first || !first.comparisonKey)
    return 'Evaluation comparison conditions were unavailable.';
  for (const evaluation of evaluations) {
    if (evaluation.comparisonKey !== first.comparisonKey)
      return 'The sampled evaluations have incompatible comparison conditions.';
    for (const task of tasks) {
      if (typeof evaluation.scores[task] !== 'number')
        return `Task ${task} comparison score was unavailable.`;
      if (
        !first.itemComparisonKeys[task] ||
        evaluation.itemComparisonKeys[task] !== first.itemComparisonKeys[task]
      )
        return `Task ${task} has incompatible comparison conditions.`;
      if (
        !first.scoreDefinitionRefs[task] ||
        evaluation.scoreDefinitionRefs[task] !== first.scoreDefinitionRefs[task]
      )
        return `Task ${task} has an incompatible score definition.`;
    }
  }
  return null;
}

function scoreConditions(
  evaluation: EvaluationOutcome,
  task: string,
): string | null {
  const comparisonKey = evaluation.comparisonKey;
  const itemComparisonKey = evaluation.itemComparisonKeys[task];
  const definitionRef = evaluation.scoreDefinitionRefs[task];
  return comparisonKey && itemComparisonKey && definitionRef
    ? digest({ comparisonKey, itemComparisonKey, definitionRef })
    : null;
}

function selectionScores(
  state: GepaState,
  evaluation: EvaluationOutcome,
): Record<string, number | null> {
  return Object.fromEntries(
    state.selectionTaskIds.map((task) => {
      const expected = state.selectionConditions[task];
      return [
        task,
        expected && expected === scoreConditions(evaluation, task)
          ? (evaluation.scores[task] ?? null)
          : null,
      ];
    }),
  );
}

async function loadPrompts(
  ctx: RuntimeContext,
  candidate: CandidateRecord,
  modules: readonly GepaModule[],
): Promise<Record<string, string>> {
  const workspace = await ctx.workspaces.create(candidate.artifactRef);
  try {
    const result: Record<string, string> = {};
    for (const module of modules)
      result[module.id] = await readFile(
        join(workspace.directory, safePath(module.path)),
        'utf8',
      );
    return result;
  } finally {
    await ctx.workspaces.release(workspace.ref);
  }
}

async function loadPopulationPrompts(
  ctx: RuntimeContext,
  candidates: readonly CandidateRecord[],
  modules: readonly GepaModule[],
): Promise<Record<string, Record<string, string>>> {
  const result: Record<string, Record<string, string>> = {};
  for (const candidate of candidates)
    result[candidate.ref] = await loadPrompts(ctx, candidate, modules);
  return result;
}

interface CommitResult {
  status: 'created' | 'no-change';
  candidateRef: string;
}

async function commitPrompts(
  ctx: RuntimeContext,
  settings: GepaSettings,
  base: CandidateRecord,
  modules: readonly GepaModule[],
  prompts: Readonly<Record<string, string>>,
): Promise<CommitResult> {
  const workspace = await ctx.workspaces.create(base.artifactRef, base.ref);
  try {
    for (const module of modules) {
      const path = join(workspace.directory, safePath(module.path));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, prompts[module.id]!, 'utf8');
    }
    const output = object(
      await ctx.application({
        action: 'commit',
        parentCandidateRef: base.ref,
        editRef: workspace.ref,
        ...(settings.editConstraints === undefined
          ? {}
          : { editConstraints: settings.editConstraints }),
      }),
    );
    if (output.action !== 'commit')
      throw new Error('GEPA Application commit returned another action');
    if (output.status !== 'created' && output.status !== 'no-change')
      throw new Error('GEPA Application commit status is invalid');
    return {
      status: output.status,
      candidateRef: string(output.candidateRef),
    };
  } finally {
    await ctx.workspaces.release(workspace.ref);
  }
}

interface CandidateMeta {
  applicationParentRef: string | null;
  parents: string[];
  ancestors: string[];
  origin: 'mutation' | 'crossover';
  createdRound: number;
  moduleIds: string[];
}

function newCandidate(
  ref: string,
  artifactRef: string,
  base: CandidateMeta,
): CandidateRecord {
  return {
    ref,
    artifactRef,
    applicationParentRef: base.applicationParentRef,
    parents: base.parents,
    ancestors: base.ancestors,
    origin: base.origin,
    createdRound: base.createdRound,
    scores: {},
    aggregate: null,
    aggregateComplete: false,
    moduleIds: base.moduleIds,
  };
}

function inheritedAncestors(
  candidates: readonly CandidateRecord[],
  parents: readonly string[],
): string[] {
  const byRef = new Map(
    candidates.map((candidate) => [candidate.ref, candidate]),
  );
  const result = new Set<string>();
  const pending = [...parents];
  while (pending.length) {
    const ref = pending.pop()!;
    if (result.has(ref)) continue;
    result.add(ref);
    const candidate = byRef.get(ref);
    if (candidate) pending.push(...candidate.ancestors, ...candidate.parents);
  }
  return [...result].sort();
}

async function recordCandidateMeta(
  ctx: RuntimeContext,
  ref: string,
  meta: CandidateMeta,
): Promise<CandidateRecord> {
  const record = await ctx.readCandidate(ref);
  return newCandidate(ref, record.artifactRef, meta);
}

function evidenceOwners(
  evaluation: EvaluationOutcome,
): Map<string, string | null> {
  const owners = new Map<string, string | null>();
  if (evaluation.evidence?.available !== true) return owners;
  const measurements = Array.isArray(evaluation.evidence.measurements)
    ? evaluation.evidence.measurements
    : [];
  for (const rawMeasurement of measurements) {
    const measurement = object(rawMeasurement);
    const entries = Array.isArray(measurement.entries)
      ? measurement.entries
      : [];
    for (const rawEntry of entries) {
      const entry = object(rawEntry);
      const owner = typeof entry.itemId === 'string' ? entry.itemId : null;
      const entryFiles = Array.isArray(entry.files) ? entry.files : [];
      for (const rawFile of entryFiles) {
        const path = object(rawFile).path;
        if (typeof path === 'string') owners.set(path, owner);
      }
    }
  }
  return owners;
}

function reflectionPayload(
  settings: GepaSettings,
  module: GepaModule,
  currentPrompt: string,
  tasks: readonly string[],
  evaluations: EvaluationOutcome,
  round: number,
  attemptId: string,
): { prompt: string; input: JsonObject; files: JsonObject } {
  const files: JsonObject = {
    [`module/${module.id}.md`]: currentPrompt,
  };
  const evidenceFiles: JsonObject = {};
  const owners = evidenceOwners(evaluations);
  const inlineEvidence = new Map<string, string>();
  let inlineBytes = 0;
  const inlineExcerpt = (path: string, content: string): string => {
    const cached = inlineEvidence.get(path);
    if (cached !== undefined) return cached;
    let value = content;
    if (value.length > 16000)
      value = `${value.slice(0, 8000)}\n\n[inline middle omitted; read_file shows the full artifact]\n\n${value.slice(-8000)}`;
    const remaining = Math.max(0, 120000 - inlineBytes);
    if (value.length > remaining)
      value = `${value.slice(0, remaining)}\n[inline evidence budget exhausted; read_file shows the full artifact]`;
    inlineBytes += value.length;
    inlineEvidence.set(path, value);
    return value;
  };
  const examples: JsonValue[] = tasks.map((task) => {
    const feedback = evaluations.feedback[task] ?? null;
    const example: JsonObject = {
      taskId: task,
      score: evaluations.scores[task] ?? null,
      scoreStatus:
        typeof evaluations.scores[task] === 'number' ? 'valid' : 'unknown',
      scoreReason: evaluations.scoreReasons[task] ?? 'unknown',
      feedback: feedback === null ? null : feedbackText(feedback),
      executionFiles: [],
    };
    if (evaluations.evidence?.available === true) {
      const sourceFiles = object(evaluations.evidence.files ?? {});
      for (const [path, value] of Object.entries(sourceFiles)) {
        const content = fileText(value);
        if (content === null) continue;
        const owner = owners.get(path) ?? null;
        if (owner !== null && owner !== task) continue;
        const safe = `${task.replace(/[^A-Za-z0-9._-]/g, '_')}/${path}`;
        files[`tasks/${safe}`] = content;
        evidenceFiles[`tasks/${safe}`] = inlineExcerpt(path, content);
        (example.executionFiles as JsonValue[]).push(`tasks/${safe}`);
      }
    }
    if (!(example.executionFiles as JsonValue[]).length)
      example.executionUnavailable =
        evaluations.evidence?.available === true
          ? 'No readable execution files were produced.'
          : (evaluations.evidence?.error ??
            'Execution evidence was unavailable.');
    return example;
  });
  const fileNames = Object.keys(files).sort();
  const summaries = tasks.map((task) => {
    const feedback = evaluations.feedback[task] ?? null;
    const score = evaluations.scores[task];
    return [
      `Task ${task}`,
      `Observed score: ${typeof score === 'number' ? String(score) : 'unavailable'} (${evaluations.scoreReasons[task] ?? 'unknown'})`,
      `Evaluator feedback:\n${feedbackText(feedback)}`,
    ].join('\n');
  });
  const prompt = [
    'You are the reflective mutation step of a GEPA optimizer.',
    `Current module: ${module.id} (${module.path}).`,
    `Objective: ${settings.goal}`,
    '',
    'Revise only the current module prompt so the system performs better on the sampled tasks.',
    'Use the sampled task inputs, observed agent outputs, execution trajectory, scores and evaluator feedback below. Do not rely on score summaries alone.',
    'Preserve useful existing instructions, do not edit any other module, and return an instruction that can be used verbatim.',
    'The authorized execution evidence is also supplied as virtual files and inline in input.executionFiles. You may inspect files with read_file, but keep reads few and leave room for your final JSON response. Do not delegate.',
    'Return only JSON matching outputSchema: { "proposal": string|null, "rationale": string }. Prefer a concrete full replacement prompt grounded in the evidence; set proposal to null only when the evidence supports no useful change at all.',
    '',
    'Supplied virtual files:',
    fileNames.map((name) => `- ${name}`).join('\n') || '- (none)',
    '',
    'Sampled executions:',
    summaries.join('\n\n'),
    '',
    'Current module prompt:',
    '```',
    currentPrompt,
    '```',
  ].join('\n');
  return {
    prompt,
    input: {
      attemptId,
      round,
      module: { id: module.id, path: module.path },
      currentPrompt,
      taskExamples: examples as JsonValue[],
      executionFiles: evidenceFiles,
      evidence: evidenceSummary(evaluations),
    },
    files,
  };
}

async function refine(
  ctx: RuntimeContext,
  settings: GepaSettings,
  state: GepaState,
  module: GepaModule,
  currentPrompt: string,
  tasks: readonly string[],
  evaluations: EvaluationOutcome,
  attemptId: string,
): Promise<{
  proposal: string | null;
  rationale: string;
  error: string | null;
}> {
  const payload = reflectionPayload(
    settings,
    module,
    currentPrompt,
    tasks,
    evaluations,
    state.completedRounds,
    attemptId,
  );
  const scope = ctx.extend({
    scope: {
      id: `gepa-reflection-${attemptId.slice(0, 24)}`,
      signal: ctx.signal,
      limits: {},
    },
  });
  try {
    const output = object(
      await scope.invokeAgent({
        agentRef: settings.reflectorBinding,
        goal: settings.goal,
        prompt: payload.prompt,
        input: payload.input,
        files: payload.files,
        outputSchema: proposalSchema,
        maxModelCalls: settings.reflectionMaxModelCalls,
      }),
    );
    const raw = typeof output.proposal === 'string' ? output.proposal : null;
    const noChange = output.noChange === true;
    const rationale =
      typeof output.rationale === 'string' ? output.rationale : '';
    if (noChange || raw === null || !raw.trim())
      return { proposal: null, rationale, error: null };
    const fence = /^```(?:[A-Za-z0-9_-]+)?\s*\r?\n([\s\S]*?)\r?\n```$/.exec(
      raw.trim(),
    );
    const proposal = (fence ? fence[1]! : raw).trim();
    return {
      proposal: proposal.length ? proposal : null,
      rationale,
      error: null,
    };
  } catch (error) {
    throwIfCancelled(ctx, error);
    return {
      proposal: null,
      rationale: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function finishState(state: GepaState, settings: GepaSettings): void {
  const best = bestCandidate(state.candidates, state.selectionTaskIds);
  state.bestCandidateRef = best.candidate?.ref ?? null;
  state.bestAggregateScore = best.score;
  const batch = Math.min(settings.minibatchSize, state.feedbackTaskIds.length);
  const minimum = batch * 2 + state.selectionTaskIds.length;
  const observed = best.candidate !== null;
  if (state.rounds.length >= settings.maxRounds) {
    state.done = true;
    state.stopReason = 'round-limit';
  } else if (!observed) {
    state.done = true;
    state.stopReason = 'selection-unavailable';
  } else if (settings.maxRollouts - state.rolloutsUsed < minimum) {
    state.done = true;
    state.stopReason = 'rollout-budget';
  } else {
    state.done = false;
    state.stopReason = null;
  }
}

async function runMutation(
  ctx: RuntimeContext,
  settings: GepaSettings,
  state: GepaState,
  rng: Rng,
  batch: string[],
  fallbackFrom: string | null,
): Promise<RoundReport> {
  const round = state.rounds.length;
  const parent = selectCandidate(state.candidates, state.selectionTaskIds, rng);
  if (!parent) throw new Error('GEPA mutation has no eligible parent');
  const modules = moduleMap(settings.modules);
  const module =
    settings.modules[state.moduleCursor % settings.modules.length]!;
  state.moduleCursor += 1;
  const prompts = await loadPrompts(ctx, parent, settings.modules);
  const currentPrompt = prompts[module.id]!;
  const attemptId = digest({
    kind: 'mutation',
    round,
    parent: parent.ref,
    module: module.id,
    seed: state.seed,
    rng: state.rng,
  });
  const parentEvaluation = await evaluateCandidate(
    ctx,
    settings,
    parent.ref,
    batch,
    'mutation-parent',
    round,
    state.evaluationRefs,
  );
  state.rolloutsUsed += parentEvaluation.rollouts;
  const reflected = await refine(
    ctx,
    settings,
    state,
    { id: module.id, path: safePath(modules.get(module.id)!.path) },
    currentPrompt,
    batch,
    parentEvaluation,
    attemptId,
  );
  const report: RoundReport = {
    round,
    strategy: 'mutation',
    status: 'rejected',
    parentRefs: [parent.ref],
    ancestorRef: null,
    moduleIds: [module.id],
    taskIds: batch,
    parentScores: scoresFor(parentEvaluation.scores, batch),
    proposalScores: [],
    candidateRef: null,
    selectionScores: {},
    rollouts: parentEvaluation.rollouts,
    reason: '',
  };
  if (fallbackFrom) report.crossoverFallback = fallbackFrom;
  if (reflected.error) {
    report.status = 'proposal-failed';
    report.reason = `Reflective proposal failed: ${reflected.error}`;
    return report;
  }
  if (reflected.proposal === null) {
    report.status = 'no-change';
    report.reason =
      reflected.rationale || 'The reflective agent proposed no change.';
    return report;
  }
  if (reflected.proposal === currentPrompt) {
    report.status = 'no-change';
    report.reason =
      'The proposed instruction is identical to the current module.';
    return report;
  }
  const committed = await commitPrompts(
    ctx,
    settings,
    parent,
    [modules.get(module.id)!],
    { [module.id]: reflected.proposal },
  );
  report.candidateRef = committed.candidateRef;
  if (committed.status === 'no-change') {
    report.status = 'no-change';
    report.reason = 'The Application reported no prompt change.';
    return report;
  }
  const candidate = await recordCandidateMeta(ctx, committed.candidateRef, {
    applicationParentRef: parent.ref,
    parents: [parent.ref],
    ancestors: inheritedAncestors(state.candidates, [parent.ref]),
    origin: 'mutation',
    createdRound: round,
    moduleIds: [module.id],
  });
  const proposalEvaluation = await evaluateCandidate(
    ctx,
    settings,
    candidate.ref,
    batch,
    'mutation-proposal',
    round,
    state.evaluationRefs,
  );
  state.rolloutsUsed += proposalEvaluation.rollouts;
  report.rollouts += proposalEvaluation.rollouts;
  report.proposalScores = scoresFor(proposalEvaluation.scores, batch);
  const parentScores = report.parentScores;
  const proposalScores = report.proposalScores;
  const incompatible = comparisonFailure(
    [parentEvaluation, proposalEvaluation],
    batch,
  );
  if (incompatible !== null) {
    report.status = 'evaluation-failed';
    report.reason = incompatible;
    return report;
  }
  const comparable =
    parentScores.length > 0 &&
    parentScores.every((value): value is number => typeof value === 'number') &&
    proposalScores.every((value): value is number => typeof value === 'number');
  if (!comparable) {
    report.reason =
      'Strict admission could not be decided because a sampled score was unavailable.';
    return report;
  }
  const before = mean(parentScores as number[])!;
  const after = mean(proposalScores as number[])!;
  report.parentMean = before;
  report.proposalMean = after;
  if (!(after > before)) {
    report.reason =
      'The proposal did not strictly improve the sampled minibatch.';
    return report;
  }
  if (state.candidates.some((existing) => existing.ref === candidate.ref)) {
    report.reason = 'The evaluated candidate is already in the population.';
    return report;
  }
  const selection = await evaluateCandidate(
    ctx,
    settings,
    candidate.ref,
    state.selectionTaskIds,
    'mutation-selection',
    round,
    state.evaluationRefs,
  );
  state.rolloutsUsed += selection.rollouts;
  report.rollouts += selection.rollouts;
  report.selectionScores = selectionScores(state, selection);
  if (Object.values(report.selectionScores).some((score) => score === null)) {
    report.status = 'evaluation-failed';
    report.reason =
      'Selection scores were unavailable or incomparable with the initial selection conditions.';
    return report;
  }
  const scored = addScores(
    candidate,
    report.selectionScores,
    state.selectionTaskIds,
  );
  state.candidates.push(scored);
  report.status = 'admitted';
  report.reason =
    'Strict minibatch improvement; candidate added to the population.';
  return report;
}

async function runCrossover(
  ctx: RuntimeContext,
  settings: GepaSettings,
  state: GepaState,
  rng: Rng,
  batch: string[],
): Promise<RoundReport | null> {
  const round = state.rounds.length;
  const prompts = await loadPopulationPrompts(
    ctx,
    state.candidates,
    settings.modules,
  );
  const choice = findMerge(
    state.candidates,
    state.selectionTaskIds,
    settings.modules,
    state.mergeAttempts,
    prompts,
    rng,
  );
  if (!choice) return null;
  if (state.mergeAttempts.includes(choice.key))
    throw new Error('GEPA merge bookkeeping selected a repeated merge');
  state.mergeAttempts.push(choice.key);
  const mergedPrompts = mergePrompts(
    settings.modules,
    choice.ancestor,
    choice.left,
    choice.right,
    prompts,
    choice.left.aggregate!,
    choice.right.aggregate!,
    rng,
  );
  const report: RoundReport = {
    round,
    strategy: 'crossover',
    status: 'rejected',
    parentRefs: [choice.left.ref, choice.right.ref],
    ancestorRef: choice.ancestor.ref,
    moduleIds: settings.modules.map((module) => module.id),
    taskIds: batch,
    parentScores: [],
    proposalScores: [],
    candidateRef: null,
    selectionScores: {},
    rollouts: 0,
    reason: '',
    mergeKey: mergeKey(choice.ancestor, choice.left, choice.right),
  };
  const committed = await commitPrompts(
    ctx,
    settings,
    choice.ancestor,
    settings.modules,
    mergedPrompts,
  );
  report.candidateRef = committed.candidateRef;
  if (committed.status === 'no-change') {
    report.status = 'no-change';
    report.reason = 'The merged prompt set did not change the ancestor.';
    return report;
  }
  const candidate = await recordCandidateMeta(ctx, committed.candidateRef, {
    applicationParentRef: choice.ancestor.ref,
    parents: [choice.left.ref, choice.right.ref],
    ancestors: inheritedAncestors(state.candidates, [
      choice.left.ref,
      choice.right.ref,
    ]),
    origin: 'crossover',
    createdRound: round,
    moduleIds: settings.modules.map((module) => module.id),
  });
  const leftEvaluation = await evaluateCandidate(
    ctx,
    settings,
    choice.left.ref,
    batch,
    'crossover-left',
    round,
    state.evaluationRefs,
  );
  state.rolloutsUsed += leftEvaluation.rollouts;
  report.rollouts += leftEvaluation.rollouts;
  const rightEvaluation = await evaluateCandidate(
    ctx,
    settings,
    choice.right.ref,
    batch,
    'crossover-right',
    round,
    state.evaluationRefs,
  );
  state.rolloutsUsed += rightEvaluation.rollouts;
  report.rollouts += rightEvaluation.rollouts;
  const proposalEvaluation = await evaluateCandidate(
    ctx,
    settings,
    candidate.ref,
    batch,
    'crossover-proposal',
    round,
    state.evaluationRefs,
  );
  state.rolloutsUsed += proposalEvaluation.rollouts;
  report.rollouts += proposalEvaluation.rollouts;
  const leftScores = scoresFor(leftEvaluation.scores, batch);
  const rightScores = scoresFor(rightEvaluation.scores, batch);
  const proposalScores = scoresFor(proposalEvaluation.scores, batch);
  report.parentScores = [...leftScores, ...rightScores];
  report.proposalScores = proposalScores;
  const incompatible = comparisonFailure(
    [leftEvaluation, rightEvaluation, proposalEvaluation],
    batch,
  );
  if (incompatible !== null) {
    report.status = 'evaluation-failed';
    report.reason = incompatible;
    return report;
  }
  const comparable =
    batch.length > 0 &&
    [...leftScores, ...rightScores, ...proposalScores].every(
      (value): value is number => typeof value === 'number',
    );
  if (!comparable) {
    report.reason =
      'Crossover admission could not be decided because a source or proposal score was unavailable.';
    return report;
  }
  const leftMean = mean(leftScores as number[])!;
  const rightMean = mean(rightScores as number[])!;
  const proposalMean = mean(proposalScores as number[])!;
  report.leftMean = leftMean;
  report.rightMean = rightMean;
  report.proposalMean = proposalMean;
  if (!(proposalMean > leftMean && proposalMean > rightMean)) {
    report.reason =
      'The merged candidate did not strictly improve on both genetic source parents.';
    return report;
  }
  if (state.candidates.some((existing) => existing.ref === candidate.ref)) {
    report.reason = 'The evaluated candidate is already in the population.';
    return report;
  }
  const selection = await evaluateCandidate(
    ctx,
    settings,
    candidate.ref,
    state.selectionTaskIds,
    'crossover-selection',
    round,
    state.evaluationRefs,
  );
  state.rolloutsUsed += selection.rollouts;
  report.rollouts += selection.rollouts;
  report.selectionScores = selectionScores(state, selection);
  if (Object.values(report.selectionScores).some((score) => score === null)) {
    report.status = 'evaluation-failed';
    report.reason =
      'Selection scores were unavailable or incomparable with the initial selection conditions.';
    return report;
  }
  const scored = addScores(
    candidate,
    report.selectionScores,
    state.selectionTaskIds,
  );
  state.candidates.push(scored);
  report.status = 'admitted';
  report.reason =
    'Merged candidate strictly improved on both source parents; candidate added to the population.';
  return report;
}

function noOpReport(state: GepaState): JsonObject {
  return {
    action: 'step',
    skipped: true,
    completedRounds: state.completedRounds,
    stopReason: state.stopReason,
  };
}

export function createGepaOptimizer(): OperationDefinition<
  GepaOptimizerInput,
  GepaOptimizerOutput,
  JsonObject
>['create'] {
  return async (): Promise<
    Operation<GepaOptimizerInput, GepaOptimizerOutput>
  > => ({
    async execute(input, context): Promise<GepaOptimizerOutput> {
      context.signal.throwIfAborted();
      moduleMap(input.settings.modules);
      if (input.action === 'initialize') {
        const settings = input.settings;
        const rng = new Rng(settings.seed);
        const wanted = Math.min(
          settings.paretoSize,
          settings.selectionTaskIds.length,
        );
        const sampled = sampleWithoutReplacement(
          rng,
          settings.selectionTaskIds,
          wanted,
        );
        const tasks = sampled.slice(
          0,
          Math.min(settings.maxRollouts, sampled.length),
        );
        const state = emptyState(settings, tasks, rng);
        state.rng = rng.state;
        state.selectionTruncated =
          tasks.length < settings.selectionTaskIds.length;
        const initial = await context.readCandidate(input.candidateRef);
        const candidate: CandidateRecord = {
          ref: initial.ref,
          artifactRef: initial.artifactRef,
          applicationParentRef: null,
          parents: [],
          ancestors: [],
          origin: 'base',
          createdRound: 0,
          scores: {},
          aggregate: null,
          aggregateComplete: false,
          moduleIds: settings.modules.map((module) => module.id),
        };
        state.baselineCandidateRef = candidate.ref;
        state.candidates = [candidate];
        let evaluation: EvaluationOutcome | null = null;
        if (tasks.length) {
          evaluation = await evaluateCandidate(
            context,
            settings,
            initial.ref,
            tasks,
            'initial-selection',
            0,
            state.evaluationRefs,
          );
          state.rolloutsUsed += evaluation.rollouts;
          state.selectionConditions = Object.fromEntries(
            tasks.map((task) => [task, scoreConditions(evaluation!, task)]),
          );
          state.candidates[0] = addScores(
            candidate,
            scoresFromEvaluation(evaluation, tasks),
            tasks,
          );
        }
        finishState(state, settings);
        return {
          state,
          report: {
            action: 'initialize',
            candidateRef: initial.ref,
            selectionTasks: tasks,
            selectionTruncated: tasks.length < settings.selectionTaskIds.length,
            scores: state.candidates[0]!.scores,
            status: evaluation?.status ?? 'unknown',
            scoreReasons: evaluation?.scoreReasons ?? {},
            evidence: evaluation ? evidenceSummary(evaluation) : null,
            rollouts: evaluation?.rollouts ?? 0,
            done: state.done,
            stopReason: state.stopReason,
          },
        };
      }
      const settings = input.settings;
      const state = readState(input.state);
      if (state.done || state.rounds.length >= settings.maxRounds) {
        if (!state.done) {
          state.done = true;
          state.stopReason =
            state.rounds.length >= settings.maxRounds
              ? 'round-limit'
              : state.stopReason;
        }
        return { state, report: noOpReport(state) };
      }
      const rng = stateRngFrom(state);
      const batchSize = Math.min(
        settings.minibatchSize,
        state.feedbackTaskIds.length,
      );
      if (!batchSize || !state.selectionTaskIds.length) {
        state.done = true;
        state.stopReason = !batchSize
          ? 'feedback-unavailable'
          : 'selection-unavailable';
        state.rng = rng.state;
        return { state, report: noOpReport(state) };
      }
      const batch = sampleWithoutReplacement(
        rng,
        state.feedbackTaskIds,
        batchSize,
      );
      const mutationCost = batch.length * 2 + state.selectionTaskIds.length;
      const crossoverCost = batch.length * 3 + state.selectionTaskIds.length;
      const remaining = settings.maxRollouts - state.rolloutsUsed;
      if (remaining < mutationCost) {
        state.done = true;
        state.stopReason = 'rollout-budget';
        state.rng = rng.state;
        return { state, report: noOpReport(state) };
      }
      const crossoverDue =
        settings.crossoverEvery > 0 &&
        (state.rounds.length + 1) % settings.crossoverEvery === 0;
      let report: RoundReport | null = null;
      if (crossoverDue && remaining >= crossoverCost)
        report = await runCrossover(context, settings, state, rng, batch);
      if (report === null) {
        report = await runMutation(
          context,
          settings,
          state,
          rng,
          batch,
          crossoverDue
            ? remaining >= crossoverCost
              ? 'no-eligible-merge'
              : 'crossover-budget'
            : null,
        );
      }
      // A completed round is a proposal that was committed as a candidate and
      // evaluated. No-change and failed proposal attempts are recorded but do
      // not inflate the acceptance count.
      if (report.status === 'admitted' || report.status === 'rejected')
        state.completedRounds += 1;
      state.rounds.push(report);
      state.rng = rng.state;
      finishState(state, settings);
      return { state, report };
    },
    async dispose(): Promise<void> {},
  });
}

/** Exported for deterministic tests of the public contract without a Runtime. */
export function publicSettings(settings: GepaSettings): GepaSettings {
  const modules = settings.modules.map((module) => ({
    id: module.id,
    path: safePath(module.path),
  }));
  moduleMap(modules);
  return { ...settings, modules };
}

export function refreshStateCandidates(state: GepaState): void {
  state.candidates = state.candidates.map((candidate) =>
    refreshCandidate(candidate, state.selectionTaskIds),
  );
}

export function candidateAncestry(
  candidate: CandidateRecord,
  candidates: readonly CandidateRecord[],
): string[] {
  return [
    ...ancestry(candidate, new Map(candidates.map((each) => [each.ref, each]))),
  ];
}
