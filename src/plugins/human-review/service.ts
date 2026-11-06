import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import type {
  JsonObject,
  OperationDefinition,
  RuntimeContext,
} from '../../contracts/index.js';
import {
  humanReviewContract,
  type HumanReviewAction,
  type HumanReviewInput,
  type HumanReviewOutput,
} from '../../contracts/plugin-types/human-review.js';
import { atomic, safeId } from '../../runtime/storage/index.js';
import { object, string } from '../../shared/json.js';
import { parseConfig, validate } from '../../shared/schema.js';
import { configSchema, type HumanReviewConfig } from './schema.js';

type ReviewRequest = HumanReviewInput & {
  requestId: string;
  experimentId: string;
  createdAt: string;
  deadline: string;
};
type SubmittedFeedback = {
  requestId: string;
  attemptId: string;
  candidateRef: string;
  action: Exclude<HumanReviewAction, 'timed-out'> | 'environment-unrepaired';
  issues: string[];
  explanation: string;
};

const text = { type: 'string', minLength: 1 };
const feedbackSchema = {
  type: 'object',
  properties: {
    requestId: text,
    attemptId: text,
    candidateRef: text,
    action: {
      enum: [
        'accept',
        'continue',
        'development-problem',
        'retry',
        'stop',
        'environment-unrepaired',
      ],
    },
    issues: { type: 'array', items: text },
    explanation: { type: 'string' },
  },
  required: [
    'requestId',
    'attemptId',
    'candidateRef',
    'action',
    'issues',
    'explanation',
  ],
  additionalProperties: false,
};

async function readJson(path: string): Promise<JsonObject> {
  return object(JSON.parse(await readFile(path, 'utf8')));
}

async function readRequest(directory: string): Promise<ReviewRequest> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Review request directory must be a real directory');
  const value = await readJson(join(directory, 'request.json'));
  const { requestId, experimentId, createdAt, deadline, ...input } = value;
  const parsed = parseConfig<HumanReviewInput>(
    humanReviewContract.input_schema,
    input,
    'Review request',
  );
  const result = {
    ...parsed,
    requestId: string(requestId),
    experimentId: string(experimentId),
    createdAt: string(createdAt),
    deadline: string(deadline),
  };
  if (!Number.isFinite(Date.parse(result.deadline)))
    throw new Error('Review deadline must be a valid timestamp');
  return result;
}

function validateFeedback(
  request: ReviewRequest,
  feedback: SubmittedFeedback,
): void {
  if (
    feedback.requestId !== request.requestId ||
    feedback.attemptId !== request.attemptId ||
    feedback.candidateRef !== request.candidateRef
  )
    throw new Error('Feedback identity does not match the active request');
  const allowed =
    request.context === 'implementation'
      ? ['accept', 'continue', 'stop']
      : request.context === 'failure'
        ? ['development-problem', 'retry', 'environment-unrepaired', 'stop']
        : ['continue', 'stop'];
  if (!allowed.includes(feedback.action))
    throw new Error(
      `Action ${feedback.action} is invalid for ${request.context} review`,
    );
  if (feedback.action === 'accept' && !request.automaticAccepted)
    throw new Error(
      'Human acceptance requires successful automatic acceptance',
    );
  if (
    ['continue', 'development-problem'].includes(feedback.action) &&
    !feedback.issues.length
  )
    throw new Error(
      'This feedback action requires original-requirement issues',
    );
  if (
    ['development-problem', 'retry', 'environment-unrepaired'].includes(
      feedback.action,
    ) &&
    !feedback.explanation.trim()
  )
    throw new Error('This feedback action requires an explanation');
}

async function locked<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await lockfile.lock(directory, {
    retries: { retries: 10, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

/** Read-only material for the standalone show command. */
export async function showReview(directory: string): Promise<JsonObject> {
  const root = resolve(directory);
  const request = await readRequest(root);
  const status = await readJson(join(root, 'status.json'));
  const report = await readJson(join(root, 'report.json'));
  return { directory: root, request, status, report };
}

/** Submit exactly one terminal decision for a still-active request. */
export async function submitFeedback(
  directory: string,
  value: unknown,
): Promise<JsonObject> {
  const feedback = parseConfig<SubmittedFeedback>(
    feedbackSchema,
    value,
    'Human feedback',
  );
  const root = resolve(directory);
  return locked(root, async () => {
    const request = await readRequest(root);
    const state = await readJson(join(root, 'status.json'));
    validateFeedback(request, feedback);
    if (
      state.status !== 'waiting' ||
      Date.now() >= Date.parse(request.deadline)
    )
      throw new Error('Review request is closed, expired, or already answered');
    const submitted = { ...feedback, submittedAt: new Date().toISOString() };
    if (feedback.action === 'environment-unrepaired') {
      await writeFile(
        join(root, `diagnosis-${randomUUID()}.json`),
        JSON.stringify(submitted, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
      return { status: 'waiting', requestId: request.requestId };
    }
    await writeFile(
      join(root, 'feedback.json'),
      JSON.stringify(submitted, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    await atomic(join(root, 'status.json'), {
      status: 'submitted',
      updatedAt: submitted.submittedAt,
    });
    return { status: 'submitted', requestId: request.requestId };
  });
}

export function reviewDirectory(
  context: RuntimeContext,
  requestId: string,
): string {
  return join(
    context.dataDirectory,
    'human-review',
    safeId(context.experimentId),
    safeId(requestId),
  );
}

export const createHumanReview: OperationDefinition<
  HumanReviewInput,
  HumanReviewOutput,
  HumanReviewConfig
>['create'] = async (rawConfig) => {
  const config = parseConfig<HumanReviewConfig>(configSchema, rawConfig);
  const shutdown = new AbortController();
  const active = new Set<Promise<HumanReviewOutput>>();
  const execute = async (
    input: HumanReviewInput,
    context: RuntimeContext,
  ): Promise<HumanReviewOutput> => {
    validate(humanReviewContract.input_schema, input, 'Human review input');
    context.signal.throwIfAborted();
    const report = object(await context.artifacts.readJson(input.reportRef));
    const requestId = randomUUID();
    const directory = reviewDirectory(context, requestId);
    const skillNavigation =
      typeof report.skillDirectory === 'string'
        ? `[Skill used](<${join(report.skillDirectory, 'skills/ember-rsi/SKILL.md').replaceAll('\\', '/')}>).`
        : `Skill candidate: ${input.candidateRef}.`;
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'report.json'),
      JSON.stringify(report, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    await writeFile(
      join(directory, 'report.md'),
      `# Development review\n\nAttempt: ${input.attemptId}\n\nCandidate: ${input.candidateRef}\n\nContext: ${input.context}\n\nAutomatic acceptance: ${input.automaticAccepted}\n\nSkill change: ${input.skillChangeExplanation ?? 'Original skill baseline'}\n\n${skillNavigation}\n\n[Saved evaluator report](report.json)\n\n${input.issues.map((issue) => `- ${issue}`).join('\n')}\n\nThe request is bound to this attempt and skill candidate. Review issues must concern unmet original requirements.\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const createdAt = new Date().toISOString();
    const deadline = new Date(
      Date.now() + (config.waitTimeoutMs ?? 86400000),
    ).toISOString();
    const request: ReviewRequest = {
      ...input,
      requestId,
      experimentId: context.experimentId,
      createdAt,
      deadline,
    };
    await atomic(join(directory, 'status.json'), { status: 'waiting' });
    await writeFile(
      join(directory, 'request.json'),
      JSON.stringify(request, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    console.log(
      `Human review ${requestId}: ${input.context}, attempt ${input.attemptId}\nSkill change: ${input.skillChangeExplanation ?? 'Original skill baseline'}\nReport: ${join(directory, 'report.md')}\nRequest: ${directory}\nDeadline: ${deadline}`,
    );
    let closed = false;
    try {
      while (true) {
        context.signal.throwIfAborted();
        const outcome = await locked(directory, async () => {
          context.signal.throwIfAborted();
          const state = await readJson(join(directory, 'status.json'));
          if (state.status === 'submitted') {
            const saved = await readJson(join(directory, 'feedback.json'));
            const { submittedAt, ...raw } = saved;
            const feedback = parseConfig<SubmittedFeedback>(
              feedbackSchema,
              raw,
              'Saved feedback',
            );
            validateFeedback(request, feedback);
            if (feedback.action === 'environment-unrepaired')
              throw new Error(
                'An unrepaired environment is not a terminal decision',
              );
            const submittedTime = Date.parse(string(submittedAt));
            if (
              !Number.isFinite(submittedTime) ||
              submittedTime >= Date.parse(deadline)
            )
              throw new Error(
                'Saved feedback was submitted after the deadline',
              );
            const result = {
              ...request,
              ...feedback,
              submittedAt,
              automaticAccepted: input.automaticAccepted,
              resolvedAt: new Date().toISOString(),
            };
            const feedbackRef = await context.artifacts.putJson(result);
            await atomic(join(directory, 'status.json'), {
              status: 'completed',
              feedbackRef,
            });
            closed = true;
            return {
              requestId,
              feedbackRef,
              action: feedback.action,
              issues: feedback.issues,
              explanation: feedback.explanation,
            };
          }
          if (Date.now() >= Date.parse(deadline)) {
            const result = {
              ...request,
              action: 'timed-out' as const,
              issues: input.issues,
              explanation: 'Human review deadline expired without a decision.',
              resolvedAt: new Date().toISOString(),
            };
            const feedbackRef = await context.artifacts.putJson(result);
            await atomic(join(directory, 'status.json'), {
              status: 'timed-out',
              feedbackRef,
            });
            closed = true;
            return {
              requestId,
              feedbackRef,
              action: result.action,
              issues: result.issues,
              explanation: result.explanation,
            };
          }
          return null;
        });
        if (outcome) return outcome;
        await delay(
          Math.min(
            config.pollIntervalMs ?? 250,
            Math.max(1, Date.parse(deadline) - Date.now()),
          ),
          undefined,
          { signal: context.signal },
        );
      }
    } finally {
      if (!closed)
        await locked(directory, async () => {
          await atomic(join(directory, 'status.json'), {
            status: context.signal.aborted ? 'cancelled' : 'failed',
            updatedAt: new Date().toISOString(),
          });
        });
    }
  };
  return {
    execute(input, context) {
      const operation = execute(
        input,
        context.extend({
          signal: AbortSignal.any([context.signal, shutdown.signal]),
        }),
      );
      active.add(operation);
      void operation.then(
        () => active.delete(operation),
        () => active.delete(operation),
      );
      return operation;
    },
    async dispose() {
      shutdown.abort(new Error('Human review disposed'));
      await Promise.allSettled(active);
    },
  };
};
