import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { JsonObject } from '../../src/contracts/index.js';
import { object, string } from '../../src/shared/json.js';
import { runGepa, decodeTree } from '../fixtures/gepa-runtime.js';

test('a complete mutation round uses sampled evidence, admits strict improvement and stops at maxRounds', async () => {
  const run = await runGepa({
    seed: 11,
    maxRounds: 1,
    maxRollouts: 20,
    feedbackTasks: ['task-a', 'task-b'],
    selectionTasks: ['task-a', 'task-b'],
    scoreTable: {
      'A0|B0': {
        scores: { 'task-a': 0.2, 'task-b': 0.2 },
        marker: 'baseline-output',
      },
      'A1|B0': {
        scores: { 'task-a': 0.6, 'task-b': 0.6 },
        marker: 'improved-output',
      },
    },
    proposals: { a: 'A1', b: 'B1' },
  });
  try {
    const output = run.output;
    assert.equal(output.completedRounds, 1);
    assert.equal(output.rolloutsUsed, 6);
    assert.equal(output.maxRollouts, 20);
    assert.equal(output.bestCandidateRef !== null, true);
    assert.equal(output.bestAggregateScore, 0.6);
    assert.equal(run.evaluationCalls.length, 3);
    assert.equal(run.agentCalls.length, 1);
    assert.equal(run.agentCalls[0]!.moduleId, 'a');
    assert.equal(run.agentCalls[0]!.maxModelCalls, 12);
    const inputText = JSON.stringify(run.agentCalls[0]!.input);
    assert.match(inputText, /TASK_INPUT_MARKER task-a/);
    assert.match(inputText, /AGENT_OUTPUT_MARKER baseline-output/);
    assert.ok(
      Object.keys(run.agentCalls[0]!.files).some((path) =>
        path.includes('tasks/task-a/'),
      ),
    );
    const examples = run.agentCalls[0]!.input.taskExamples as JsonObject[];
    const exampleA = examples.find((example) => example.taskId === 'task-a')!;
    const exampleB = examples.find((example) => example.taskId === 'task-b')!;
    assert.ok(
      (exampleA.executionFiles as string[]).every((path) =>
        path.startsWith('tasks/task-a/'),
      ),
    );
    assert.ok(
      (exampleB.executionFiles as string[]).every((path) =>
        path.startsWith('tasks/task-b/'),
      ),
    );
    const candidates = output.candidates as JsonObject[];
    const best = candidates.find(
      (candidate) => candidate.ref === output.bestCandidateRef,
    );
    const tree = object(
      await run.manager.artifacts.readJson(string(best!.artifactRef)),
    );
    const files = decodeTree(tree);
    assert.equal(files['a.md'], 'A1');
    assert.equal(files['b.md'], 'B0');
    const rounds = output.rounds as JsonObject[];
    assert.equal(rounds[0]!.strategy, 'mutation');
    assert.equal(rounds[0]!.status, 'admitted');
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('crossover eligibility retains a non-instance-winning parent and admission compares both sources', async () => {
  // Base wins both selection instances and dominates the first mutation so the
  // second mutation deterministically starts from base. The two mutations are
  // therefore sibling branches with complementary module changes.
  const run = await runGepa({
    seed: 3,
    maxRounds: 4,
    maxRollouts: 40,
    feedbackTasks: ['feedback-a', 'feedback-b'],
    selectionTasks: ['selection-a', 'selection-b'],
    scoreTable: {
      'A0|B0': {
        scores: {
          'feedback-a': 0.2,
          'feedback-b': 0.2,
          'selection-a': 1,
          'selection-b': 0.6,
        },
      },
      'A1|B0': {
        scores: {
          'feedback-a': 0.9,
          'feedback-b': 0.9,
          'selection-a': 0.9,
          'selection-b': 0.7,
        },
      },
      'A0|B1': {
        scores: {
          'feedback-a': 0.85,
          'feedback-b': 0.85,
          'selection-a': 0.7,
          'selection-b': 0.9,
        },
      },
      'A1|B1': {
        scores: {
          'feedback-a': 1,
          'feedback-b': 1,
          'selection-a': 0.95,
          'selection-b': 0.95,
        },
      },
    },
    proposals: { a: 'A1', b: 'B1' },
  });
  try {
    const output = run.output;
    const rounds = output.rounds as JsonObject[];
    assert.ok(rounds.length <= 4);
    assert.equal(output.completedRounds, rounds.length);
    // The third strategy is crossover and must compare the merged candidate
    // with both source siblings, never with the common construction ancestor.
    const crossover = rounds.find((round) => round.strategy === 'crossover');
    assert.ok(crossover, 'expected an admitted crossover round');
    assert.equal(crossover.status, 'admitted');
    assert.equal((crossover.parentRefs as string[]).length, 2);
    assert.equal(crossover.parentMean, undefined);
    assert.equal(crossover.leftMean !== undefined, true);
    assert.equal(crossover.rightMean !== undefined, true);
    assert.equal(crossover.proposalMean, 1);
    assert.equal(output.completedRounds, 4);
    assert.equal(rounds[3]!.strategy, 'mutation');
    assert.deepEqual(rounds[3]!.moduleIds, ['a']);
    assert.equal(run.agentCalls.length, 3);
    assert.deepEqual(
      run.agentCalls.map((call) => call.moduleId),
      ['a', 'b', 'a'],
    );
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('small rollout allowances truncate before evaluation and never exceed the boundary', async () => {
  const run = await runGepa({
    seed: 2,
    maxRounds: 3,
    maxRollouts: 1,
    feedbackTasks: ['task-a', 'task-b'],
    selectionTasks: ['task-a', 'task-b'],
    scoreTable: {
      'A0|B0': {
        scores: { 'task-a': 1, 'task-b': 1 },
      },
      'A1|B0': { scores: { 'task-a': 1, 'task-b': 1 } },
    },
    proposals: { a: 'A1' },
  });
  try {
    const output = run.output;
    assert.equal(output.rolloutsUsed, 1);
    assert.equal(output.completedRounds, 0);
    assert.equal(run.evaluationCalls.length, 1);
    assert.equal(run.evaluationCalls[0]!.taskIds.length, 1);
    assert.equal((output.selectionTaskIds as string[]).length, 1);
    assert.equal(run.agentCalls.length, 0);
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('unavailable and failed evaluations stay unknown instead of becoming zero', async () => {
  const unavailable = await runGepa({
    seed: 5,
    maxRounds: 1,
    maxRollouts: 20,
    feedbackTasks: ['task-a'],
    selectionTasks: ['task-a'],
    scoreTable: {
      'A0|B0': { scores: { 'task-a': null } },
      'A1|B0': { scores: { 'task-a': 0.9 } },
    },
    proposals: { a: 'A1' },
  });
  try {
    const output = unavailable.output;
    assert.equal(output.bestAggregateScore, null);
    assert.equal(output.bestCandidateRef, null);
    assert.equal(output.completedRounds, 0);
    assert.equal(unavailable.agentCalls.length, 0);
  } finally {
    await unavailable.manager.dispose();
    await rm(unavailable.root, { recursive: true, force: true });
  }

  const failed = await runGepa({
    seed: 5,
    maxRounds: 1,
    maxRollouts: 20,
    feedbackTasks: ['feedback-a'],
    selectionTasks: ['selection-a'],
    scoreTable: {
      'A0|B0': {
        scores: { 'feedback-a': 0.8, 'selection-a': 0.8 },
        statuses: { 'feedback-a': 'failed' },
      },
      'A1|B0': {
        scores: { 'feedback-a': 0.9, 'selection-a': 0.9 },
      },
    },
    proposals: { a: 'A1' },
  });
  try {
    const output = failed.output;
    assert.equal(output.completedRounds, 0);
    const rounds = output.rounds as JsonObject[];
    assert.equal(rounds[0]!.status, 'evaluation-failed');
    assert.match(String(rounds[0]!.reason), /unavailable/);
    assert.equal(output.bestAggregateScore, 0.8);
    assert.notEqual(output.bestCandidateRef, null);
  } finally {
    await failed.manager.dispose();
    await rm(failed.root, { recursive: true, force: true });
  }
});

test('a no-change proposal is recorded without counting a completed round', async () => {
  const run = await runGepa({
    seed: 8,
    maxRounds: 1,
    maxRollouts: 20,
    feedbackTasks: ['task-a'],
    selectionTasks: ['task-a'],
    scoreTable: {
      'A0|B0': { scores: { 'task-a': 0.7 } },
    },
    proposals: { a: 'A0' },
  });
  try {
    const output = run.output;
    assert.equal(output.completedRounds, 0);
    assert.equal((output.rounds as JsonObject[]).length, 1);
    assert.equal(run.agentCalls.length, 1);
    assert.equal(run.evaluationCalls.length, 2);
    const rounds = output.rounds as JsonObject[];
    assert.equal(rounds[0]!.status, 'no-change');
    assert.equal(output.bestAggregateScore, 0.7);
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('three logical reflection attempts are executed and counted separately', async () => {
  const run = await runGepa({
    seed: 3,
    maxRounds: 3,
    maxRollouts: 40,
    feedbackTasks: ['task-a'],
    selectionTasks: ['task-a'],
    scoreTable: {
      'A0|B0': { scores: { 'task-a': 1 } },
      'A1|B0': { scores: { 'task-a': 0.2 } },
      'A2|B0': { scores: { 'task-a': 0.3 } },
      'A0|B1': { scores: { 'task-a': 0.4 } },
    },
    proposals: { a: 'A2', b: 'B1' },
  });
  try {
    const output = run.output;
    assert.equal(output.completedRounds, 3);
    assert.equal(run.agentCalls.length, 3);
    assert.deepEqual(
      run.agentCalls.map((call) => call.moduleId),
      ['a', 'b', 'a'],
    );
    const rounds = output.rounds as JsonObject[];
    assert.equal(rounds.length, 3);
    assert.ok(rounds.every((round) => round.status === 'rejected'));
    // Initial selection + parent/proposal for each of the three logical rounds.
    assert.equal(output.rolloutsUsed, 7);
    assert.equal(run.evaluationCalls.length, 7);
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('a final-round crossover rejected against both parents starts no further work', async () => {
  const run = await runGepa({
    seed: 3,
    maxRounds: 3,
    maxRollouts: 40,
    feedbackTasks: ['feedback-a', 'feedback-b'],
    selectionTasks: ['selection-a', 'selection-b'],
    scoreTable: {
      'A0|B0': {
        scores: {
          'feedback-a': 0.2,
          'feedback-b': 0.2,
          'selection-a': 1,
          'selection-b': 0.6,
        },
      },
      'A1|B0': {
        scores: {
          'feedback-a': 0.9,
          'feedback-b': 0.9,
          'selection-a': 0.9,
          'selection-b': 0.7,
        },
      },
      'A0|B1': {
        scores: {
          'feedback-a': 0.85,
          'feedback-b': 0.85,
          'selection-a': 0.7,
          'selection-b': 0.9,
        },
      },
      'A1|B1': {
        scores: {
          'feedback-a': 0.4,
          'feedback-b': 0.4,
          'selection-a': 0.95,
          'selection-b': 0.95,
        },
      },
    },
    proposals: { a: 'A1', b: 'B1' },
  });
  try {
    const output = run.output;
    const rounds = output.rounds as JsonObject[];
    assert.equal(output.completedRounds, 3);
    assert.equal(rounds.length, 3);
    assert.equal(rounds[2]!.strategy, 'crossover');
    assert.equal(rounds[2]!.status, 'rejected');
    assert.match(String(rounds[2]!.reason), /both genetic source parents/);
    assert.equal(run.agentCalls.length, 2);
    assert.equal(output.rolloutsUsed, 20);
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('a measured zero is retained as a valid best aggregate', async () => {
  const run = await runGepa({
    seed: 1,
    maxRounds: 0,
    maxRollouts: 4,
    feedbackTasks: ['task-a'],
    selectionTasks: ['task-a'],
    scoreTable: {
      'A0|B0': { scores: { 'task-a': 0 } },
    },
    proposals: {},
  });
  try {
    const output = run.output;
    assert.equal(output.completedRounds, 0);
    assert.equal(output.rolloutsUsed, 1);
    assert.equal(output.bestAggregateScore, 0);
    assert.notEqual(output.bestCandidateRef, null);
    assert.equal(run.evaluationCalls.length, 1);
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});

test('eight controlled evidence reads plus a final response fit the reflective session', async () => {
  const run = await runGepa({
    seed: 6,
    maxRounds: 1,
    maxRollouts: 20,
    feedbackTasks: ['task-a'],
    selectionTasks: ['task-a'],
    scoreTable: {
      'A0|B0': { scores: { 'task-a': 0.2 } },
      'A1|B0': { scores: { 'task-a': 0.9 } },
    },
    proposals: { a: 'A1' },
    reads: 8,
    maxModelCalls: 12,
  });
  try {
    assert.equal(run.output.completedRounds, 1);
    assert.equal(run.agentCalls.length, 1);
    assert.equal(run.agentCalls[0]!.modelCalls, 9);
    assert.equal(run.agentCalls[0]!.maxModelCalls, 12);
  } finally {
    await run.manager.dispose();
    await rm(run.root, { recursive: true, force: true });
  }
});
