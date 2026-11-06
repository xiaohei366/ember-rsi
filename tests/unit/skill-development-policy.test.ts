import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RuntimeContext,
  type JsonObject,
  type JsonValue,
} from '../../src/contracts/index.js';
import { agentContract } from '../../src/contracts/plugin-types/agent.js';
import { proposerContract } from '../../src/contracts/plugin-types/proposer.js';
import { developmentContract } from '../../src/contracts/plugin-types/development.js';
import { humanReviewContract } from '../../src/contracts/plugin-types/human-review.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { object } from '../../src/shared/json.js';

type Scenario = {
  outcomes: string[];
  decisions?: string[];
  proposals?: string[];
  maxRounds?: number;
  preflightReady?: boolean;
};

async function run(
  scenario: Scenario,
): Promise<{ output: JsonObject; calls: JsonObject[] }> {
  const registry = new Registry();
  for (const contract of [
    agentContract,
    proposerContract,
    developmentContract,
    humanReviewContract,
  ])
    registry.registerContract(contract);
  try {
    const policy = await Policy.load(
      'src/policies/skill-development/policy.yaml',
      registry,
    );
    const calls: JsonObject[] = [];
    let attempt = 0;
    let proposal = 0;
    let review = 0;
    const output = object(
      await policy.execute({
        input: { candidateRef: 'baseline' },
        config: { maxRounds: scenario.maxRounds ?? 10 },
        application: {},
        context: new RuntimeContext().extend({
          signal: new AbortController().signal,
        }),
        checkpoint: async () => {},
        invoke: async (binding, value): Promise<JsonValue> => {
          const input = object(value);
          calls.push({ binding, ...input });
          if (binding === 'evaluator') {
            if (input.action === 'preflight')
              return {
                action: 'preflight',
                ready: scenario.preflightReady ?? true,
                reportRef: 'preflight-report',
              };
            if (input.action === 'export')
              return { action: 'export', packageRef: 'package' };
            assert.equal(input.attempt, ++attempt);
            return {
              action: 'evaluate',
              attemptId: `attempt-${attempt}`,
              candidateRef: input.candidateRef,
              outcome: scenario.outcomes[attempt - 1] ?? 'automatic-pass',
              reportRef: `report-${attempt}`,
            };
          }
          if (binding === 'proposer') {
            const status = scenario.proposals?.[proposal] ?? 'created';
            proposal++;
            return status === 'created'
              ? {
                  status,
                  candidateRef: `skill-${proposal}`,
                  diffRef: `diff-${proposal}`,
                  rationale: 'Reusable guidance',
                }
              : {
                  status,
                  candidateRef: input.parent,
                  diffRef: null,
                  rationale: 'No justified edit',
                };
          }
          assert.equal(binding, 'reviewer');
          const action = scenario.decisions?.[review] ?? 'accept';
          review++;
          return {
            requestId: `request-${review}`,
            action,
            issues:
              action === 'continue' || action === 'development-problem'
                ? ['Original requirement remains unmet']
                : [],
            explanation:
              action === 'retry' ? 'Environment repaired' : 'Reviewed',
            feedbackRef: `feedback-${review}`,
          };
        },
      }),
    );
    return { output, calls };
  } finally {
    await registry.dispose();
  }
}

test('skill development routes development and human issues into proposals then exports the reviewed pair', async () => {
  const { output, calls } = await run({
    outcomes: ['development-failure', 'automatic-pass', 'automatic-pass'],
    decisions: ['continue', 'accept'],
  });
  assert.equal(output.status, 'accepted');
  assert.equal(output.attempts, 3);
  assert.equal(output.firstReportRef, 'report-1');
  assert.deepEqual(output.reportRefs, ['report-1', 'report-2', 'report-3']);
  const proposals = calls.filter((call) => call.binding === 'proposer');
  assert.deepEqual(proposals[1].evidenceRefs, [
    'report-1',
    'report-2',
    'feedback-1',
  ]);
  assert.deepEqual(proposals[1].sources, [
    { candidateRef: 'baseline' },
    { candidateRef: 'skill-1' },
  ]);
  assert.deepEqual(
    calls.filter((call) => call.action === 'evaluate')[2].acceptanceIssues,
    ['Original requirement remains unmet'],
  );
  assert.deepEqual(calls.at(-1), {
    binding: 'evaluator',
    action: 'export',
    candidateRef: 'skill-2',
    reportRef: 'report-3',
    reviewRef: 'feedback-2',
  });
});

test('environment repair retries the same skill and still counts failed attempts', async () => {
  const { output, calls } = await run({
    outcomes: ['environment-failure', 'automatic-pass'],
    decisions: ['retry', 'accept'],
  });
  assert.equal(output.attempts, 2);
  assert.equal(output.candidateRef, 'baseline');
  assert.equal(calls.filter((call) => call.binding === 'proposer').length, 0);
  assert.equal(
    calls.find((call) => call.binding === 'reviewer')?.context,
    'failure',
  );
});

test('uncertain failure requires diagnosis before revision and no-change requires fresh human input', async () => {
  const { output, calls } = await run({
    outcomes: ['uncertain-failure', 'automatic-pass'],
    decisions: ['development-problem', 'continue', 'accept'],
    proposals: ['no-change', 'created'],
  });
  assert.equal(output.status, 'accepted');
  assert.equal(output.attempts, 2);
  assert.deepEqual(
    calls
      .filter((call) => call.binding === 'reviewer')
      .map((call) => call.context),
    ['failure', 'no-change', 'implementation'],
  );
  assert.equal(calls.filter((call) => call.binding === 'proposer').length, 2);
});

test('stop, review timeout, and exhausted rounds remain explicitly unfinished without export', async () => {
  for (const action of ['stop', 'timed-out']) {
    const { output, calls } = await run({
      outcomes: ['automatic-pass'],
      decisions: [action],
    });
    assert.equal(output.status, 'unfinished');
    assert.equal(output.stopReason, action);
    assert.equal(output.packageRef, null);
    assert.equal(
      calls.some((call) => call.action === 'export'),
      false,
    );
  }
  const { output, calls } = await run({
    outcomes: ['development-failure', 'development-failure'],
    maxRounds: 2,
  });
  assert.equal(output.status, 'unfinished');
  assert.equal(output.stopReason, 'max-rounds');
  assert.equal(output.attempts, 2);
  assert.equal(calls.filter((call) => call.binding === 'proposer').length, 1);
});

test('preflight failure starts no development and consumes no rounds', async () => {
  const { output, calls } = await run({ outcomes: [], preflightReady: false });
  assert.equal(output.attempts, 0);
  assert.equal(output.status, 'unfinished');
  assert.equal(output.stopReason, 'preflight-failed');
  assert.deepEqual(
    calls.map((call) => call.action),
    ['preflight'],
  );
});
