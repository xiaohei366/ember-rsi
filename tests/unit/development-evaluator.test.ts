import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeContext } from '../../src/contracts/runtime/context.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import {
  createDevelopmentEvaluator,
  validateAcceptance,
  acceptanceValidationVersion,
} from '../../src/plugins/evaluator-development/service.js';
import { runAcceptanceProcess } from '../../src/plugins/evaluator-development/process.js';
import { sdkConfiguration } from '../../src/plugins/evaluator-development/sdk.js';
import { object, string } from '../../src/shared/json.js';
import {
  acceptanceEnvelope,
  developmentFixture,
} from '../fixtures/development-fixture.js';
import type { JsonObject } from '../../src/contracts/index.js';
import { parseUserConfig, resolveConfig } from 'ember-evaluator';

async function verifyEnvelope(value: JsonObject): Promise<JsonObject> {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-acceptance-facts-'));
  try {
    await writeFile(join(directory, 'result.json'), JSON.stringify(value));
    return await validateAcceptance(directory, string(value.attemptId));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function baselineOnly(value: JsonObject): void {
  if (
    !Array.isArray(value.candidates) ||
    !Array.isArray(value.measurements) ||
    !Array.isArray(value.calls)
  )
    throw new Error('Fixture facts missing');
  value.candidates = value.candidates.slice(0, 1);
  value.measurements = value.measurements.slice(0, 1);
  value.calls = value.calls.filter((raw) =>
    ['call-initialize', 'call-eval-baseline'].includes(
      string(object(raw).callId),
    ),
  );
}

test('thin Policy accepts a correlated plugin-owned candidate round without a DSL loop', async () => {
  const envelope = acceptanceEnvelope('acceptance-thin-policy');
  assert.deepEqual(envelope.boundaries, []);
  const result = await verifyEnvelope(envelope);
  assert.equal(result.validationVersion, acceptanceValidationVersion);
  assert.equal(object(result.roundEvidence).kind, 'candidate-lineage');
  assert.equal(
    object(result.roundEvidence).candidateRef,
    'candidate-office-child',
  );
});

test('unknown legacy item mapping requires bound native completed execution and valid scoring', async () => {
  const envelope = acceptanceEnvelope('acceptance-native-status');
  if (!Array.isArray(envelope.measurements))
    throw new Error('Fixture measurements missing');
  for (const raw of envelope.measurements) {
    const items = object(object(raw).items).items;
    if (!Array.isArray(items)) throw new Error('Fixture items missing');
    for (const item of items) object(item).status = 'unknown';
  }
  const result = await verifyEnvelope(envelope);
  assert.equal(object(result.roundEvidence).kind, 'candidate-lineage');
});

for (const defect of [
  'invalid-score',
  'unknown-execution',
  'feedback-reference',
  'native-attempt',
] as const) {
  test(`acceptance rejects ${defect} evaluator evidence`, async () => {
    const envelope = acceptanceEnvelope(`acceptance-${defect}`);
    if (!Array.isArray(envelope.measurements))
      throw new Error('Fixture measurements missing');
    for (const raw of envelope.measurements) {
      const evaluations = object(raw).evaluations;
      if (!Array.isArray(evaluations))
        throw new Error('Fixture evaluation evidence missing');
      const evidence = object(evaluations[0]);
      if (defect === 'invalid-score')
        object(evidence.feedback).scoreStatus = 'invalid';
      if (defect === 'unknown-execution')
        object(evidence.nativeRecord).executionStatus = 'unknown';
      if (defect === 'feedback-reference')
        evidence.artifactRef = 'artifact:unrelated';
      if (defect === 'native-attempt')
        object(object(evidence.nativeRecord).key).attemptId = 'another-attempt';
    }
    await assert.rejects(
      verifyEnvelope(envelope),
      /actual successful execution\/evaluation record/,
    );
  });
}

test('plugin-owned no-change round accepts actual evaluation and proposal receipts without a Policy loop', async () => {
  const envelope = acceptanceEnvelope('acceptance-no-change-plugin');
  if (!Array.isArray(envelope.calls)) throw new Error('Fixture calls missing');
  const proposal = object(
    envelope.calls.find((raw) => object(raw).callId === 'call-proposal'),
  );
  baselineOnly(envelope);
  proposal.parentCallId = 'custom-owner';
  proposal.path = 'custom-owner';
  proposal.output = {
    status: 'no-change',
    candidateRef: 'candidate-office',
    diffRef: null,
  };
  if (!Array.isArray(envelope.calls)) throw new Error('Fixture calls missing');
  envelope.calls.push(proposal, {
    experimentId: envelope.attemptId!,
    callId: 'custom-owner',
    parentCallId: 'root',
    path: 'steps/business',
    pluginId: 'custom.gepa',
    contractId: 'contract.custom-gepa',
    status: 'succeeded',
    input: { candidateRef: 'candidate-office' },
    output: { completedRounds: 1 },
    startedAt: new Date(2).toISOString(),
    finishedAt: new Date(7).toISOString(),
  });
  const result = await verifyEnvelope(envelope);
  assert.equal(object(result.roundEvidence).kind, 'plugin-no-change');
});

test('baseline-only empty loop cannot substantiate a forged completedRounds claim', async () => {
  const envelope = acceptanceEnvelope('acceptance-baseline-only');
  baselineOnly(envelope);
  object(object(envelope.experiment).output).completedRounds = 99;
  envelope.boundaries = [
    {
      experimentId: envelope.attemptId!,
      policyScopeId: 'root',
      boundary: 'iteration-completed',
      stepPath: 'steps/empty/iteration-0',
    },
  ];
  await assert.rejects(verifyEnvelope(envelope), /correlated completed GEPA/);
});

for (const defect of [
  'uncommitted-child',
  'wrong-lineage',
  'foreign-candidate',
  'wrong-measurement-call',
  'child-not-evaluated',
] as const) {
  test(`acceptance rejects ${defect} framework evidence`, async () => {
    const envelope = acceptanceEnvelope(`acceptance-${defect}`);
    if (
      !Array.isArray(envelope.calls) ||
      !Array.isArray(envelope.candidates) ||
      !Array.isArray(envelope.measurements)
    )
      throw new Error('Fixture facts missing');
    if (defect === 'uncommitted-child')
      envelope.calls = envelope.calls.filter(
        (raw) => object(raw).callId !== 'call-commit',
      );
    if (defect === 'wrong-lineage')
      object(envelope.candidates[1]).parentRef = 'candidate-unknown';
    if (defect === 'foreign-candidate')
      object(envelope.candidates[1]).experimentId = 'another-attempt';
    if (defect === 'wrong-measurement-call')
      object(
        object(
          envelope.calls.find(
            (raw) => object(raw).callId === 'call-eval-child',
          ),
        ).output,
      ).measurementRef = 'measurement-unrelated';
    if (defect === 'child-not-evaluated')
      envelope.measurements = envelope.measurements.slice(0, 1);
    await assert.rejects(
      verifyEnvelope(envelope),
      /correlated completed GEPA|ownership/,
    );
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rsi-development-'));
  const external = await developmentFixture(root);
  const context = new RuntimeContext();
  const artifacts = new FileArtifacts(join(root, '.rsi/artifacts'));
  const skill = join(root, 'skill');
  await mkdir(join(skill, 'skills/ember-rsi/references'), { recursive: true });
  await mkdir(join(skill, 'skills/ember-rsi/assets'), { recursive: true });
  await writeFile(
    join(skill, 'skills/ember-rsi/SKILL.md'),
    '# Current candidate skill\n',
  );
  await writeFile(
    join(skill, 'skills/ember-rsi/references/plugins.md'),
    '# Current plugin guidance\n',
  );
  await writeFile(
    join(skill, 'skills/ember-rsi/assets/fixed.yaml'),
    'fixed: true\n',
  );
  const artifactRef = await artifacts.capture(skill);
  const controller = new AbortController();
  Object.assign(context, {
    rootDirectory: root,
    dataDirectory: join(root, '.rsi'),
    directory: join(root, '.rsi/calls/fixture'),
    experimentId: 'experiment-development',
    callId: 'call-development',
    bindingId: 'development',
    signal: controller.signal,
    cleanup: new AbortController().signal,
    artifacts,
    async readCandidate(ref: string) {
      assert.equal(ref, 'candidate-skill');
      return {
        ref,
        artifactRef,
        parentRef: null,
        experimentId: context.experimentId,
      };
    },
    async charge() {},
  });
  const evaluator = await createDevelopmentEvaluator(
    external.config,
    context,
    external.boundaries,
  );
  return { root, ...external, context, controller, evaluator };
}

test('development freezes preflight, supplies exact skill, retains first acceptance and exports only bound human acceptance', async () => {
  const f = await fixture();
  try {
    const preflight = await f.evaluator.execute(
      { action: 'preflight', candidateRef: 'candidate-skill' },
      f.context,
    );
    assert.equal(preflight.action, 'preflight');
    assert.ok(preflight.action === 'preflight' && preflight.ready);
    // Later changes to original inputs cannot alter frozen development materials.
    await writeFile(
      join(f.config.development.bundle, f.config.development.skillPrompt),
      'Changed original prompt\n',
    );
    const result = await f.evaluator.execute(
      {
        action: 'evaluate',
        candidateRef: 'candidate-skill',
        attempt: 1,
        acceptanceIssues: ['Preserve the originally required main algorithm.'],
      },
      f.context,
    );
    assert.equal(result.action, 'evaluate');
    if (result.action !== 'evaluate') throw new Error('Unexpected output');
    assert.equal(result.outcome, 'automatic-pass');
    assert.deepEqual(f.state.suppliedSkills, ['# Current candidate skill\n']);
    assert.match(
      f.state.taskInstructions[0],
      /Preserve the originally required/,
    );
    const report = object(await f.context.artifacts.readJson(result.reportRef));
    assert.equal(object(report.developmentCost).totalTokens, 40);
    assert.equal(object(report.developmentCost).modelCalls, null);
    assert.equal(object(report.developmentCost).durationMs, 35);
    assert.equal(object(report.acceptance).status, 'passed');
    assert.equal(f.state.acceptanceCalls, 1);
    assert.equal(object(object(report.development)).status, 'completed');
    const review = {
      experimentId: f.context.experimentId,
      attemptId: result.attemptId,
      candidateRef: result.candidateRef,
      reportRef: result.reportRef,
      requestId: 'review-fixture',
      context: 'implementation',
      action: 'accept',
      automaticAccepted: true,
    };
    const wrongReview = await f.context.artifacts.putJson({
      ...review,
      attemptId: 'another-attempt',
    });
    await assert.rejects(
      f.evaluator.execute(
        {
          action: 'export',
          candidateRef: result.candidateRef,
          reportRef: result.reportRef,
          reviewRef: wrongReview,
        },
        f.context,
      ),
      /bound human acceptance/,
    );
    const reviewRef = await f.context.artifacts.putJson(review);
    const exported = await f.evaluator.execute(
      {
        action: 'export',
        candidateRef: result.candidateRef,
        reportRef: result.reportRef,
        reviewRef,
      },
      f.context,
    );
    assert.equal(exported.action, 'export');
    if (exported.action !== 'export') throw new Error('Unexpected export');
    const output = join(f.root, 'export');
    await f.context.artifacts.materialize(exported.packageRef, output);
    assert.equal(
      await readFile(
        join(output, 'skill/skills/ember-rsi/assets/fixed.yaml'),
        'utf8',
      ),
      'fixed: true\n',
    );
    assert.equal(
      object(JSON.parse(await readFile(join(output, 'review.json'), 'utf8')))
        .attemptId,
      result.attemptId,
    );
    assert.match(
      await readFile(join(output, 'README.md'), 'utf8'),
      /\[report\]\(report\.json\)/,
    );
    assert.match(
      await readFile(
        join(output, 'implementation/.gepa/extension/index.mjs'),
        'utf8',
      ),
      /register/,
    );
  } finally {
    await f.evaluator.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('expected development failure returns feedback with retained source and does not invoke independent acceptance', async () => {
  const f = await fixture();
  f.state.developmentOutcomes = ['development-failure'];
  try {
    await f.evaluator.execute(
      { action: 'preflight', candidateRef: 'candidate-skill' },
      f.context,
    );
    const result = await f.evaluator.execute(
      {
        action: 'evaluate',
        candidateRef: 'candidate-skill',
        attempt: 1,
        acceptanceIssues: [],
      },
      f.context,
    );
    assert.ok(result.action === 'evaluate');
    if (result.action !== 'evaluate') throw new Error('Unexpected result');
    assert.equal(result.outcome, 'development-failure');
    const report = object(await f.context.artifacts.readJson(result.reportRef));
    assert.ok(object(report.development).sourceRef);
    assert.equal(object(report.acceptance).status, 'not-run');
    assert.equal(f.state.acceptanceCalls, 0);
    assert.equal(f.context.signal.aborted, false);
  } finally {
    await f.evaluator.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('preflight failure stops before development and unknown environmental outcomes remain diagnostic data', async () => {
  const f = await fixture();
  f.state.preflightReady = false;
  try {
    const result = await f.evaluator.execute(
      { action: 'preflight', candidateRef: 'candidate-skill' },
      f.context,
    );
    assert.ok(result.action === 'preflight' && !result.ready);
    await assert.rejects(
      f.evaluator.execute(
        {
          action: 'evaluate',
          candidateRef: 'candidate-skill',
          attempt: 1,
          acceptanceIssues: [],
        },
        f.context,
      ),
      /successful preflight/,
    );
    assert.equal(f.state.developmentCalls, 0);
  } finally {
    await f.evaluator.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const acceptance of ['no-task', 'no-round', 'baseline-only'] as const) {
  test(`a clean acceptance exit without ${acceptance} framework evidence does not pass`, async () => {
    const f = await fixture();
    f.state.acceptanceOutcomes = [acceptance];
    try {
      await f.evaluator.execute(
        { action: 'preflight', candidateRef: 'candidate-skill' },
        f.context,
      );
      const result = await f.evaluator.execute(
        {
          action: 'evaluate',
          candidateRef: 'candidate-skill',
          attempt: 1,
          acceptanceIssues: [],
        },
        f.context,
      );
      assert.ok(
        result.action === 'evaluate' &&
          result.outcome === 'development-failure',
      );
    } finally {
      await f.evaluator.dispose();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test('global cancellation retains the partial development report and propagates abort', async () => {
  const f = await fixture();
  try {
    const base = f.boundaries.runSdk!;
    let calls = 0;
    const evaluator = await createDevelopmentEvaluator(f.config, f.context, {
      ...f.boundaries,
      async runSdk(options) {
        const result = await base(options);
        if (++calls === 2)
          f.controller.abort(new Error('Controlled global cancellation'));
        return result;
      },
    });
    await evaluator.execute(
      { action: 'preflight', candidateRef: 'candidate-skill' },
      f.context,
    );
    await assert.rejects(
      evaluator.execute(
        {
          action: 'evaluate',
          candidateRef: 'candidate-skill',
          attempt: 1,
          acceptanceIssues: [],
        },
        f.context,
      ),
      /Controlled global cancellation/,
    );
    const records = await import('node:fs/promises').then((fs) =>
      fs.readdir(
        join(f.root, '.rsi/experiments/experiment-development/development'),
      ),
    );
    const attempt = records.find((name) => name.startsWith('development-1-'));
    assert.ok(attempt);
    const report = object(
      JSON.parse(
        await readFile(
          join(
            f.root,
            '.rsi/experiments/experiment-development/development',
            attempt!,
            'report.json',
          ),
          'utf8',
        ),
      ),
    );
    assert.ok(string(object(report.development).sourceRef));
    await evaluator.dispose();
  } finally {
    await f.evaluator.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('SDK configuration uses supported fixed task selection and validates through the pinned SDK', async () => {
  const f = await fixture();
  try {
    const native = sdkConfiguration(
      f.config.development.sdk,
      f.config.development.bundle,
      f.config.development.taskId,
      join(f.root, 'sdk'),
      60000,
    );
    object(object(native.benchmark).config).source = {
      kind: 'local',
      path: f.config.development.taskPackage,
    };
    parseUserConfig(native);
    const resolved = resolveConfig(
      join(f.root, 'evaluator.json'),
      parseUserConfig(native),
      [],
    );
    assert.ok(resolved);
    assert.equal(object(native.run).offset, 0);
    assert.equal(Object.hasOwn(object(native.run), 'skip'), false);
  } finally {
    await f.evaluator.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('independent runner builds a fresh source copy and a clean exit without WorkBuddy is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-independent-acceptance-'));
  try {
    const source = join(root, 'delivery');
    await mkdir(source);
    for (const path of [
      'src',
      'scripts',
      'web',
      'package.json',
      'pnpm-lock.yaml',
      ...(await readdir(resolve('.'))).filter((path) =>
        /^tsconfig.*\.json$/.test(path),
      ),
    ])
      await cp(resolve(path), join(source, path), { recursive: true });
    await cp(resolve('docs/users/assets'), join(source, 'docs/users/assets'), {
      recursive: true,
    });
    await mkdir(join(source, '.gepa/extension'), { recursive: true });
    await cp(
      resolve('examples/harness/dsh-harness2/baseline'),
      join(source, '.gepa/input/office-bundle'),
      { recursive: true },
    );
    await writeFile(
      join(source, '.gepa/input/office-target.yaml'),
      `schemaVersion: rsi.target/v1
id: fixture.office
entries:
  - path: plugins/office-base/prompts/office-discipline.md
    kind: file
    description: Fixed Office prompt
    changes: [modify]
`,
    );
    await writeFile(
      join(source, '.gepa/extension/index.mjs'),
      `
import { fileURLToPath } from 'node:url';
export function register(registry) {
  registry.registerPolicy('fixture.gepa', fileURLToPath(new URL('./policy.yaml', import.meta.url)));
}
`,
    );
    await writeFile(
      join(source, '.gepa/extension/policy.yaml'),
      `schemaVersion: rsi.policy/v1
id: fixture.gepa
input_schema: { type: object }
output_schema: { type: object }
steps:
  - id: round
    type: loop
    maxIterations: 1
    steps: []
output: { completedRounds: 1 }
`,
    );
    await writeFile(
      join(source, '.gepa/recipe.yaml'),
      `schemaVersion: rsi.recipe/v1
id: fixture-gepa
application:
  plugin: application.agentbundle
  config:
    target: { schema: ./input/office-target.yaml }
    baseline: { directory: ./input/office-bundle }
policy: { id: fixture.gepa, config: {}, input: {} }
bindings: {}
`,
    );
    const outputDirectory = join(root, 'acceptance');
    await mkdir(outputDirectory);
    const result = await runAcceptanceProcess({
      attemptId: 'independent-attempt',
      sourceDirectory: source,
      recipePath: '.gepa/recipe.yaml',
      pluginDirectory: '.gepa/extension',
      outputDirectory,
      signal: new AbortController().signal,
    });
    if (result.exitCode !== 0)
      throw new Error(
        await readFile(join(outputDirectory, 'runner.log'), 'utf8'),
      );
    assert.equal(result.timedOut, false);
    const evidence = object(
      JSON.parse(await readFile(join(outputDirectory, 'result.json'), 'utf8')),
    );
    assert.equal(object(evidence.experiment).status, 'succeeded');
    assert.ok(Array.isArray(evidence.boundaries) && evidence.boundaries.length);
    await assert.rejects(
      validateAcceptance(outputDirectory, 'independent-attempt'),
      /selected WorkBuddy task/,
    );
    // The original retained source never receives build output or live dependency links.
    assert.equal((await readdir(source)).includes('dist'), false);
    assert.equal((await readdir(source)).includes('node_modules'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('development deadline retains evidence without diagnosing timeout as a coding problem', async () => {
  const f = await fixture();
  try {
    const evaluator = await createDevelopmentEvaluator(
      { ...f.config, developmentTimeoutMs: 10 },
      f.context,
      {
        ...f.boundaries,
        async runSdk(options) {
          const native = object(
            JSON.parse(await readFile(options.configPath, 'utf8')),
          );
          if (
            (object(native.run).taskIds as string[])[0].startsWith('workbuddy/')
          )
            return f.boundaries.runSdk!(options);
          if (!options.signal.aborted)
            await new Promise<void>((resolve) =>
              options.signal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
          throw new Error('Controlled stage abort');
        },
      },
    );
    await evaluator.execute(
      { action: 'preflight', candidateRef: 'candidate-skill' },
      f.context,
    );
    const result = await evaluator.execute(
      {
        action: 'evaluate',
        candidateRef: 'candidate-skill',
        attempt: 1,
        acceptanceIssues: [],
      },
      f.context,
    );
    assert.ok(
      result.action === 'evaluate' && result.outcome === 'uncertain-failure',
    );
    if (result.action !== 'evaluate') throw new Error('Unexpected output');
    const report = object(await f.context.artifacts.readJson(result.reportRef));
    assert.equal(object(report.development).status, 'timed-out');
    assert.equal(object(report.developmentCost).totalTokens, null);
    await evaluator.dispose();
  } finally {
    await f.evaluator.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('independent acceptance deadline retains its first output separately from development cost', async () => {
  const f = await fixture();
  try {
    const evaluator = await createDevelopmentEvaluator(
      { ...f.config, acceptanceTimeoutMs: 200 },
      f.context,
      {
        ...f.boundaries,
        async runAcceptance(request) {
          await writeFile(
            join(request.outputDirectory, 'partial.txt'),
            'Partial independent evidence\n',
          );
          if (!request.signal.aborted)
            await new Promise<void>((resolve) =>
              request.signal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
          return { exitCode: null, timedOut: true };
        },
      },
    );
    await evaluator.execute(
      { action: 'preflight', candidateRef: 'candidate-skill' },
      f.context,
    );
    const result = await evaluator.execute(
      {
        action: 'evaluate',
        candidateRef: 'candidate-skill',
        attempt: 1,
        acceptanceIssues: [],
      },
      f.context,
    );
    assert.ok(
      result.action === 'evaluate' && result.outcome === 'uncertain-failure',
    );
    if (result.action !== 'evaluate') throw new Error('Unexpected output');
    const report = object(await f.context.artifacts.readJson(result.reportRef));
    assert.equal(object(report.acceptance).status, 'timed-out');
    assert.equal(object(report.developmentCost).durationMs, 35);
    const firstResult = await f.context.artifacts.readJson(
      string(object(report.acceptance).firstResultRef),
    );
    assert.match(JSON.stringify(firstResult), /partial.txt/);
    await evaluator.dispose();
  } finally {
    await f.evaluator.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const outcome of [
  'environment-failure',
  'uncertain-failure',
  'missing-delivery',
] as const) {
  test(`development ${outcome} does not cross the fatal Runtime boundary or start acceptance`, async () => {
    const f = await fixture();
    f.state.developmentOutcomes = [outcome];
    try {
      await f.evaluator.execute(
        { action: 'preflight', candidateRef: 'candidate-skill' },
        f.context,
      );
      const result = await f.evaluator.execute(
        {
          action: 'evaluate',
          candidateRef: 'candidate-skill',
          attempt: 1,
          acceptanceIssues: [],
        },
        f.context,
      );
      assert.ok(
        result.action === 'evaluate' &&
          result.outcome ===
            (outcome === 'missing-delivery' ? 'development-failure' : outcome),
      );
      assert.equal(f.state.acceptanceCalls, 0);
      assert.equal(f.context.signal.aborted, false);
    } finally {
      await f.evaluator.dispose();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}
