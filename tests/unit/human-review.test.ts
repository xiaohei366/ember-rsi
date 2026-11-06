import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeContext } from '../../src/contracts/index.js';
import type { HumanReviewInput } from '../../src/contracts/plugin-types/human-review.js';
import { humanReviewContract } from '../../src/contracts/plugin-types/human-review.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import { humanReviewDefinition } from '../../src/plugins/human-review/index.js';
import {
  showReview,
  submitFeedback,
} from '../../src/plugins/human-review/service.js';
import { runFeedbackCommand } from '../../src/plugins/human-review/feedback.js';
import { object, string } from '../../src/shared/json.js';
import { validate } from '../../src/shared/schema.js';

async function fixture(): Promise<{
  root: string;
  context: RuntimeContext;
  controller: AbortController;
  input: HumanReviewInput;
}> {
  const root = await mkdtemp(join(tmpdir(), 'rsi-human-review-'));
  const artifacts = new FileArtifacts(join(root, 'artifacts'));
  const controller = new AbortController();
  const context = new RuntimeContext().extend({
    dataDirectory: join(root, '.rsi'),
    experimentId: 'review-test',
    signal: controller.signal,
    artifacts,
  });
  const reportRef = await artifacts.putJson({
    execution: 'delivered',
    automaticAcceptance: 'passed',
    developmentCost: { tokens: null },
    skill: { candidateRef: 'candidate-1', changes: 'Original skill' },
    skillDirectory: join(root, 'retained-skill'),
    retainedFiles: ['delivery/policy.yaml'],
  });
  return {
    root,
    context,
    controller,
    input: {
      attemptId: 'attempt-1',
      candidateRef: 'candidate-1',
      reportRef,
      context: 'implementation',
      automaticAccepted: true,
      issues: [],
      skillChangeExplanation:
        'Document explicit extension registration based on startup evidence.',
    },
  };
}

async function pendingDirectory(root: string): Promise<string> {
  const parent = join(root, '.rsi', 'human-review', 'review-test');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      for (const name of await readdir(parent)) {
        const directory = join(parent, name);
        try {
          await readFile(join(directory, 'request.json'));
          return directory;
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
      }
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
    await delay(5);
  }
  throw new Error('Review request was not created');
}

async function feedback(
  directory: string,
  action: string,
  issues: string[] = [],
  explanation = '',
): Promise<{
  requestId: string;
  attemptId: string;
  candidateRef: string;
  action: string;
  issues: string[];
  explanation: string;
}> {
  const request = object(
    JSON.parse(await readFile(join(directory, 'request.json'), 'utf8')),
  );
  return {
    requestId: string(request.requestId),
    attemptId: string(request.attemptId),
    candidateRef: string(request.candidateRef),
    action,
    issues,
    explanation,
  };
}

test('human review retains reports and returns request-bound acceptance evidence', async () => {
  const { root, input, context } = await fixture();
  const plugin = await humanReviewDefinition.create(
    { pollIntervalMs: 5 },
    context,
  );
  try {
    const waiting = plugin.execute(input, context);
    const directory = await pendingDirectory(root);
    const material = await showReview(directory);
    assert.equal(object(material.request).candidateRef, input.candidateRef);
    assert.equal(object(material.report).execution, 'delivered');
    const submitted = await feedback(directory, 'accept');
    const file = join(root, 'feedback.json');
    await writeFile(file, JSON.stringify(submitted));
    await runFeedbackCommand(['submit', directory, file]);
    const output = await waiting;
    validate(humanReviewContract.output_schema, output);
    assert.equal(output.action, 'accept');
    const evidence = object(
      await context.artifacts.readJson(output.feedbackRef),
    );
    assert.equal(evidence.attemptId, input.attemptId);
    assert.equal(evidence.candidateRef, input.candidateRef);
    assert.equal(evidence.reportRef, input.reportRef);
    assert.equal(evidence.automaticAccepted, true);
    assert.equal(
      object((await showReview(directory)).status).status,
      'completed',
    );
    await assert.rejects(
      submitFeedback(directory, submitted),
      /closed|answered/,
    );
    assert.match(
      await readFile(join(directory, 'report.md'), 'utf8'),
      /Saved evaluator report/,
    );
    assert.match(
      await readFile(join(directory, 'report.md'), 'utf8'),
      /Document explicit extension registration/,
    );
    assert.match(
      await readFile(join(directory, 'report.md'), 'utf8'),
      /\[Skill used\].*skills\/ember-rsi\/SKILL.md/,
    );
    assert.deepEqual(
      await runFeedbackCommand(['show', directory]),
      await showReview(directory),
    );
    await assert.rejects(runFeedbackCommand(['unknown', directory]), /Usage/);
  } finally {
    await plugin.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('failure diagnosis waits for confirmed repair without moving the deadline', async () => {
  const { root, input, context } = await fixture();
  const plugin = await humanReviewDefinition.create(
    { pollIntervalMs: 5 },
    context,
  );
  try {
    const waiting = plugin.execute(
      { ...input, context: 'failure', automaticAccepted: false },
      context,
    );
    const directory = await pendingDirectory(root);
    const before = object((await showReview(directory)).request);
    await assert.rejects(
      submitFeedback(directory, await feedback(directory, 'accept')),
      /invalid/,
    );
    await assert.rejects(
      submitFeedback(directory, await feedback(directory, 'retry')),
      /explanation/,
    );
    assert.deepEqual(
      await submitFeedback(
        directory,
        await feedback(
          directory,
          'environment-unrepaired',
          [],
          'Endpoint is unavailable.',
        ),
      ),
      {
        status: 'waiting',
        requestId: before.requestId,
      },
    );
    const after = await showReview(directory);
    assert.equal(object(after.request).deadline, before.deadline);
    assert.equal(object(after.status).status, 'waiting');
    await submitFeedback(
      directory,
      await feedback(directory, 'retry', [], 'Endpoint repaired and verified.'),
    );
    assert.equal((await waiting).action, 'retry');
    assert.equal(
      (await readdir(directory)).filter((name) => name.startsWith('diagnosis-'))
        .length,
      1,
    );
  } finally {
    await plugin.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ['implementation', 'failure', 'no-change'] as const) {
  test(`human ${mode} review validates feedback actions and original-requirement issues`, async () => {
    const { root, input, context } = await fixture();
    const plugin = await humanReviewDefinition.create(
      { pollIntervalMs: 5 },
      context,
    );
    try {
      const waiting = plugin.execute(
        { ...input, context: mode, automaticAccepted: false },
        context,
      );
      const directory = await pendingDirectory(root);
      const action = mode === 'failure' ? 'development-problem' : 'continue';
      await assert.rejects(
        submitFeedback(directory, await feedback(directory, action)),
        /issues/,
      );
      if (mode === 'implementation')
        await assert.rejects(
          submitFeedback(directory, await feedback(directory, 'accept')),
          /automatic acceptance/,
        );
      if (mode === 'no-change')
        await assert.rejects(
          submitFeedback(
            directory,
            await feedback(directory, 'retry', [], 'Repair complete'),
          ),
          /invalid/,
        );
      await submitFeedback(
        directory,
        await feedback(
          directory,
          action,
          ['The original startup requirement is unmet.'],
          'Confirmed in the retained trace.',
        ),
      );
      assert.equal((await waiting).action, action);
    } finally {
      await plugin.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('concurrent and stale submissions cannot replace a completed decision', async () => {
  const { root, input, context } = await fixture();
  const plugin = await humanReviewDefinition.create(
    { pollIntervalMs: 5 },
    context,
  );
  try {
    const waiting = plugin.execute(input, context);
    const directory = await pendingDirectory(root);
    const submitted = await feedback(directory, 'stop');
    for (const key of ['requestId', 'attemptId', 'candidateRef'] as const)
      await assert.rejects(
        submitFeedback(directory, { ...submitted, [key]: 'old' }),
        /identity/,
      );
    const results = await Promise.allSettled([
      submitFeedback(directory, submitted),
      submitFeedback(directory, submitted),
    ]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal((await waiting).action, 'stop');
    assert.equal(
      object(
        JSON.parse(await readFile(join(directory, 'feedback.json'), 'utf8')),
      ).action,
      'stop',
    );
  } finally {
    await plugin.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('silence times out unfinished and rejects feedback after expiry', async () => {
  const { root, input, context } = await fixture();
  const plugin = await humanReviewDefinition.create(
    { waitTimeoutMs: 80, pollIntervalMs: 5 },
    context,
  );
  try {
    const waiting = plugin.execute(input, context);
    const directory = await pendingDirectory(root);
    const output = await waiting;
    assert.equal(output.action, 'timed-out');
    assert.equal(
      object(await context.artifacts.readJson(output.feedbackRef)).action,
      'timed-out',
    );
    await assert.rejects(
      submitFeedback(directory, await feedback(directory, 'accept')),
      /closed|expired/,
    );
  } finally {
    await plugin.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation closes the active request and retains its material', async () => {
  const { root, input, context, controller } = await fixture();
  const plugin = await humanReviewDefinition.create(
    { pollIntervalMs: 5 },
    context,
  );
  try {
    const waiting = plugin.execute(input, context);
    const rejected = assert.rejects(waiting, /abort|cancel/i);
    const directory = await pendingDirectory(root);
    controller.abort(new Error('Review cancelled'));
    await rejected;
    assert.equal(
      object((await showReview(directory)).status).status,
      'cancelled',
    );
    await assert.rejects(
      submitFeedback(directory, await feedback(directory, 'stop')),
      /closed/,
    );
    assert.ok(await readFile(join(directory, 'report.md'), 'utf8'));
  } finally {
    await plugin.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('disposing the plugin cancels and settles its pending waits', async () => {
  const { root, input, context } = await fixture();
  const plugin = await humanReviewDefinition.create(
    { pollIntervalMs: 5 },
    context,
  );
  try {
    const waiting = plugin.execute(input, context);
    const rejected = assert.rejects(waiting, /abort|disposed/i);
    const directory = await pendingDirectory(root);
    await plugin.dispose();
    await rejected;
    assert.equal(
      object((await showReview(directory)).status).status,
      'cancelled',
    );
    await assert.rejects(
      submitFeedback(directory, await feedback(directory, 'accept')),
      /closed/,
    );
  } finally {
    await plugin.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
