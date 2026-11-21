import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  memoryContract,
  type JsonObject,
  type OperationDefinition,
  type RuntimeContext,
} from '../../src/contracts/index.js';
import { object, string } from '../../src/shared/json.js';
import { managerFixture } from '../helpers/manager-fixture.js';
import { ObservationQueries } from '../../src/runtime/services/observation.js';

function generator(
  execute: (input: JsonObject, ctx: RuntimeContext) => Promise<JsonObject>,
): OperationDefinition {
  return {
    id: 'test.memory',
    contract: memoryContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        execute: (input, ctx) => execute(object(input), ctx),
        async dispose() {},
      };
    },
  };
}
async function proposal(
  ctx: RuntimeContext,
  content: string,
  path = 'notes.md',
): Promise<JsonObject> {
  return {
    status: 'proposed',
    reason: 'Observed experience',
    changeRef: await ctx.artifacts.putJson({ path }),
    resourceRef: await ctx.artifacts.putJson({
      kind: 'file-tree',
      files: [
        {
          path,
          mode: process.platform === 'win32' ? 0o666 : 0o644,
          base64: Buffer.from(content).toString('base64'),
        },
      ],
    }),
  };
}
const memory: JsonObject = {
  plugin: 'test.memory',
  trigger: { afterIteration: 'rounds' },
  observe: { steps: ['deliver'], includeCandidateDiffs: false },
  consumers: ['driver'],
};
const policy = (config: JsonObject): JsonObject => ({
  defaults: { memory: config },
  steps: [
    {
      id: 'rounds',
      type: 'loop',
      maxIterations: 3,
      steps: [{ id: 'deliver', type: 'invoke', use: 'driver' }],
    },
  ],
  output: { memoryRef: '${{ memory.ref }}' },
});
test('Memory pins each consumer call, isolates rejected proposals, exports a snapshot, and explicitly seeds another experiment', async (t) => {
  let count = 0;
  const snapshots: (string | null)[] = [];
  let firstCall: RuntimeContext | undefined;
  const fixture = await managerFixture(
    async (ctx) => {
      if (!firstCall) {
        firstCall = ctx;
        return {};
      }
      // First read the earlier call's pinned seed after the active pointer has advanced.
      if (!snapshots.length)
        snapshots.push(
          (await firstCall.readMemory())?.files['notes.md'] ?? null,
        );
      const snapshot = await ctx.readMemory();
      snapshots.push(snapshot?.files['notes.md'] ?? null);
      return {};
    },
    {
      plugins: [
        generator(async (_input, ctx) => {
          assert.equal(await ctx.readMemory(), null);
          await assert.rejects(
            ctx.facts.write('candidates', 'other', {}),
            /cannot write Application candidates/,
          );
          await assert.rejects(
            ctx.recordCandidate('artifact:ignored', null),
            /cannot create Application candidates/,
          );
          await assert.rejects(
            ctx.application({ action: 'initialize' }),
            /cannot create Application candidates/,
          );
          if (++count === 2) throw new Error('Model unavailable');
          return proposal(
            ctx,
            'new experience',
            count === 3 ? 'forbidden.txt' : 'notes.md',
          );
        }),
      ],
      policy: policy({
        ...memory,
        editConstraints: { allowedPaths: ['notes.md'] },
        seed: { directory: './seed' },
      }),
    },
  );
  t.after(() => fixture.dispose());
  const { manager } = fixture,
    root = manager.rootDirectory;
  await mkdir(join(root, 'seed'));
  await writeFile(join(root, 'seed', 'notes.md'), 'seeded');
  const record = await fixture.run(),
    runs = await manager.facts.list('learning-runs');
  assert.deepEqual(snapshots, ['seeded', 'new experience', 'new experience']);
  assert.equal(runs.filter((run) => run.status === 'rejected').length, 2);
  assert.equal(runs.filter((run) => run.status === 'activated').length, 1);
  const ref = string(object(record.learning).memoryRef);
  assert.equal(object(record.output).memoryRef, ref);
  const calls = await manager.facts.list('calls');
  assert.equal(
    calls.filter((c) => c.bindingId === 'driver' && c.memoryRef === ref).length,
    2,
  );
  assert.ok(runs.every((r) => calls.some((c) => c.callId === r.callId)));
  const observed = await new ObservationQueries(
    manager.facts,
    manager.artifacts,
    manager.directory,
  ).learning('test', 'memories');
  assert.ok(
    observed.some(
      (row) => row.id === ref && row.status === 'activated' && row.callId,
    ),
  );
  const target = join(root, 'export');
  await manager.memory().apply(ref, { to: target });
  assert.equal(
    await readFile(join(target, 'notes.md'), 'utf8'),
    'new experience',
  );
  assert.equal(
    await readFile(join(root, 'seed', 'notes.md'), 'utf8'),
    'seeded',
  );
  const path = join(root, 'recipe.yaml');
  const { parse, stringify } = await import('yaml');
  const recipe = object(parse(await readFile(path, 'utf8')));
  recipe.memory = { seed: { fromExperiment: 'test' } };
  await writeFile(path, stringify(recipe));
  await manager.run(path, { id: 'seeded' });
  assert.equal(snapshots[3], 'new experience');
  const seeds = (await manager.facts.list('memories')).filter(
    (m) => m.experimentId === 'seeded' && m.kind === 'initial',
  );
  assert.deepEqual(seeds[0]?.seededFrom, {
    experimentId: 'test',
    memoryRef: ref,
  });
});
test('global cancellation and budget errors stop learning; a local model cap rejects only that invocation', async (t) => {
  for (const mode of ['cancel', 'global', 'local', 'ledger'])
    await t.test(mode, async (t) => {
      const controller = new AbortController();
      const fixture = await managerFixture(async () => ({}), {
        plugins: [
          generator(async (_input, ctx) => {
            if (mode === 'cancel') {
              controller.abort(new Error('cancelled experiment'));
              ctx.signal.throwIfAborted();
            }
            await ctx.charge('modelCalls', 1);
            return proposal(ctx, 'survived');
          }),
        ],
        budget: { modelCalls: mode === 'global' ? 0 : 10 },
        policy: policy({
          ...memory,
          ...(mode === 'local' ? { budget: { modelCalls: 0 } } : {}),
        }),
      });
      t.after(() => fixture.dispose());
      const { manager } = fixture,
        path = join(manager.rootDirectory, 'recipe.yaml');
      if (mode === 'ledger') {
        const write = manager.facts.write.bind(manager.facts);
        manager.facts.write = async (kind, id, fact) => {
          if (kind === 'budgets' && fact.modelCalls === 1)
            throw new Error('ledger unavailable');
          await write(kind, id, fact);
        };
      }
      if (mode === 'local') {
        assert.equal((await fixture.run()).status, 'succeeded');
        assert.ok(
          (await manager.facts.list('learning-runs')).every(
            (r) => r.status === 'rejected',
          ),
        );
      } else {
        await assert.rejects(
          manager.run(path, { id: 'test', signal: controller.signal }),
          mode === 'cancel'
            ? /cancelled/
            : mode === 'global'
              ? /Budget exceeded/
              : /ledger unavailable/,
        );
        assert.equal(
          (await manager.get('test')).status,
          mode === 'cancel' ? 'cancelled' : 'failed',
        );
      }
    });
});

for (const boundary of [
  'evidence-prepared',
  'prepared',
  'generator-receipt',
  'validated',
  'activation',
  'activated',
  'disable',
  'budget',
] as const) {
  test('Memory resumes at the ' + boundary + ' boundary', async (t) => {
    let generations = 0,
      deliveries = 0;
    const fixture = await managerFixture(
      async () => {
        deliveries++;
        return {};
      },
      {
        plugins: [
          generator(async (_input, ctx) => {
            generations++;
            return proposal(ctx, 'experience');
          }),
        ],
        policy: {
          defaults: {
            memory: { ...memory, trigger: { afterStep: 'deliver' } },
          },
          steps: [{ id: 'deliver', type: 'invoke', use: 'driver' }],
          output: { ref: '${{ memory.ref }}' },
        },
      },
    );
    t.after(() => fixture.dispose());
    const { manager } = fixture,
      path = join(manager.rootDirectory, 'recipe.yaml');
    const controller = new AbortController();
    const write = manager.facts.write.bind(manager.facts);
    manager.facts.write = async (kind, id, data) => {
      await write(kind, id, data);
      const phase =
        boundary === 'disable' || boundary === 'budget' ? 'prepared' : boundary;
      if (
        (kind === 'learning-runs' && data.status === phase) ||
        (phase === 'generator-receipt' &&
          kind === 'calls' &&
          data.bindingId === '_memory' &&
          data.status === 'succeeded') ||
        (phase === 'activation' && kind === 'activations' && data.memory)
      )
        controller.abort(new Error('interrupted at ' + boundary));
    };
    await assert.rejects(
      manager.run(path, { id: 'recovery', signal: controller.signal }),
      /interrupted/,
    );
    manager.facts.write = write;
    if (boundary === 'disable' || boundary === 'budget') {
      const { parse, stringify } = await import('yaml');
      const recipe = object(parse(await readFile(path, 'utf8')));
      recipe.memory =
        boundary === 'disable'
          ? { enabled: false }
          : { budget: { modelCalls: 1 } };
      await writeFile(path, stringify(recipe));
    }
    const result = await manager.run(path, { id: 'recovery', resume: true });
    assert.equal(deliveries, 1);
    assert.equal(generations, boundary === 'disable' ? 0 : 1);
    if (boundary === 'disable') assert.equal(object(result.output).ref, null);
    else {
      const ref = string(object(result.output).ref);
      assert.equal(object(result.learning).memoryRef, ref);
      assert.equal((await manager.facts.list('memories')).length, 1);
    }
  });
}

test('a learning deadline permits the next step while the generator lease drains', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deliveries = 0;
  const fixture = await managerFixture(
    async () => {
      if (++deliveries === 2) release();
      return {};
    },
    {
      budget: { modelCalls: 0 },
      plugins: [
        generator(async (_input, ctx) => {
          await gate;
          await ctx.charge('modelCalls', 1);
          return proposal(ctx, 'late');
        }),
      ],
      policy: {
        defaults: {
          memory: {
            ...memory,
            trigger: { afterStep: 'deliver' },
            budget: { timeoutSeconds: 1 },
          },
        },
        steps: [
          { id: 'deliver', type: 'invoke', use: 'driver' },
          { id: 'next', type: 'invoke', use: 'driver' },
        ],
        output: { ref: '${{ memory.ref }}' },
      },
    },
  );
  t.after(async () => {
    release();
    await fixture.dispose();
  });
  const result = await fixture.run();
  assert.equal(deliveries, 2);
  assert.equal(object(result.learning).memoryRef, null);
  assert.equal(
    (await fixture.manager.facts.list('learning-runs'))[0]?.status,
    'rejected',
  );
  assert.equal(
    (await fixture.manager.facts.list('calls')).find(
      (c) => c.bindingId === '_memory',
    )?.status,
    'cancelled',
  );
});

test('Memory charges removed bytes and accepts an empty reason on a no-change result', async (t) => {
  let second = false;
  const fixture = await managerFixture(async () => ({}), {
    plugins: [
      generator(async (_input, ctx) => {
        if (second)
          return {
            status: 'no-change',
            resourceRef: null,
            changeRef: null,
            reason: '',
          };
        second = true;
        return {
          status: 'proposed',
          reason: 'delete',
          resourceRef: await ctx.artifacts.putJson({
            kind: 'file-tree',
            files: [],
          }),
          changeRef: await ctx.artifacts.putJson({ path: 'keep.txt' }),
        };
      }),
    ],
    policy: policy({
      ...memory,
      seed: { directory: './seed' },
      editConstraints: { maxChangedBytes: 0 },
    }),
  });
  t.after(() => fixture.dispose());
  const seed = join(fixture.manager.rootDirectory, 'seed');
  await mkdir(seed);
  await writeFile(join(seed, 'keep.txt'), 'kept');
  await fixture.run();
  const runs = await fixture.manager.facts.list('learning-runs');
  assert.equal(
    runs.filter(
      (run) =>
        run.status === 'rejected' &&
        String(run.reason).includes('edit constraints'),
    ).length,
    1,
  );
  assert.equal(
    runs.filter((run) => run.status === 'no-change' && run.reason === '')
      .length,
    2,
  );
  assert.equal((await fixture.manager.facts.list('memories')).length, 1);
});

test('Memory rejects file and directory collisions before a custom proposal becomes active', async (t) => {
  const fixture = await managerFixture(async () => ({}), {
    plugins: [
      generator(async (_input, ctx) => ({
        status: 'proposed',
        reason: 'bad tree',
        changeRef: await ctx.artifacts.putJson({}),
        resourceRef: await ctx.artifacts.putJson({
          kind: 'file-tree',
          files: ['notes', 'notes/example'].map((path) => ({
            path,
            base64: '',
            mode: 0o644,
          })),
        }),
      })),
    ],
    policy: policy(memory),
  });
  t.after(() => fixture.dispose());
  const record = await fixture.run();
  assert.equal(object(record.learning).memoryRef, null);
  assert.ok(
    (await fixture.manager.facts.list('learning-runs')).every(
      (r) =>
        r.status === 'rejected' &&
        String(r.reason).includes('also a directory'),
    ),
  );
});
