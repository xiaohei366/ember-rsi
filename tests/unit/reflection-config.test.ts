import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  agentContract,
  applicationContract,
  memoryContract,
  proposerContract,
  reflectionContract,
  type JsonObject,
  type PluginContract,
} from '../../src/contracts/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { Policy } from '../../src/runtime/policy/index.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { FileArtifacts } from '../../src/runtime/storage/index.js';
import {
  lockDefinition,
  parseLockedMemory,
  parseLockedReflection,
  readResourceOrigins,
} from '../../src/runtime/manager/definition-lock.js';
import { object, string } from '../../src/shared/json.js';
import {
  compileTrigger,
  matchesStepPath,
  resolveTriggerTarget,
} from '../../src/runtime/learning/trigger.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'rsi-learning-config-'));
  const registry = new Registry();
  t.after(async () => {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const policyDir = join(root, 'policy'),
    recipeDir = join(root, 'recipe');
  await mkdir(policyDir);
  await mkdir(recipeDir);
  await mkdir(join(policyDir, 'guidance'));
  await mkdir(join(recipeDir, 'seed'));
  await writeFile(join(recipeDir, 'seed', 'notes.md'), 'seed');
  await writeFile(join(policyDir, 'inherited.md'), 'policy prompt');
  await writeFile(join(recipeDir, 'override.md'), 'recipe prompt');
  await writeFile(join(policyDir, 'goal.md'), 'policy goal');
  const file = { type: 'string', 'x-rsi-path': 'file' };
  function register(
    id: string,
    contract: PluginContract,
    properties: JsonObject = {},
  ) {
    registry.registerOperation({
      id,
      contract,
      configSchema: { type: 'object', properties, additionalProperties: false },
      async create() {
        throw new Error('Recipe loading must not create any instances');
      },
    });
  }
  register('application.test', applicationContract);
  register('proposer.test', proposerContract, {
    guidance: { type: 'string', 'x-rsi-path': 'directory' },
  });
  register('agent.test', agentContract);
  register('memory.test', memoryContract, {
    goalFile: file,
    resources: { type: 'object', properties: { a: file, b: file } },
  });
  register('memory.other', memoryContract);
  register('reflection.test', reflectionContract);
  register('memory.agent', memoryContract, {
    agentRef: { type: 'string' },
    prompt: file,
  });
  const policy: JsonObject = {
    schemaVersion: 'rsi.policy/v1',
    id: 'learning',
    input_schema: { type: 'object' },
    output_schema: true,
    require: {
      proposer: { contract: proposerContract.id },
      backend: { contract: agentContract.id },
    },
    defaults: {
      bindings: {
        proposer: {
          plugin: 'proposer.test',
          config: { guidance: './guidance' },
        },
        backend: { plugin: 'agent.test' },
      },
    },
    steps: [
      {
        id: 'search',
        type: 'loop',
        maxIterations: 2,
        steps: [{ id: 'propose', type: 'invoke', use: 'proposer' }],
      },
    ],
    output: '${{ memory.ref }}',
  };
  const decl = {
    schemaVersion: 'rsi.recipe/v1',
    id: 'probe',
    application: { plugin: 'application.test' },
    policy: { id: 'learning' },
  };
  const policyPath = join(policyDir, 'policy.yaml');
  registry.registerPolicy('learning', policyPath);
  async function load(overrides: JsonObject) {
    await writeFile(policyPath, JSON.stringify(policy));
    return Recipe.fromJSON({ ...decl, ...overrides }, registry, {
      sourcePath: join(recipeDir, 'recipe.yaml'),
    });
  }
  return { root, registry, policy, policyDir, recipeDir, load };
}

test('learning modules merge resource origins, mutually exclusive fields, permissions and budgets; v3 locks immutable inputs', async (t) => {
  const { root, registry, policy, policyDir, recipeDir, load } =
    await fixture(t);
  object(policy.defaults).memory = {
    plugin: 'memory.test',
    trigger: { afterIteration: 'search' },
    config: {
      goalFile: './inherited.md',
      resources: { a: './inherited.md', b: './missing.md' },
    },
    observe: { steps: ['propose'] },
    goal: 'initial goal',
    seed: { fromExperiment: 'previous' },
    budget: { modelCalls: 0, timeoutSeconds: 2 },
  };
  object(policy.defaults).reflection = {
    enabled: false,
    plugin: 'reflection.test',
    targets: { proposer: { resources: ['guidance'] } },
    goalFile: './goal.md',
    trigger: { afterPolicy: true },
  };
  const recipe = await load({
    memory: {
      config: { resources: { b: './override.md' } },
      goalFile: './override.md',
      seed: { directory: './seed' },
      budget: { evidenceBytes: 99 },
    },
    reflection: { enabled: true },
  });
  assert.deepEqual(recipe.memory?.config.resources, {
    a: join(policyDir, 'inherited.md'),
    b: join(recipeDir, 'override.md'),
  });
  assert.equal(recipe.memory?.goal, 'recipe prompt');
  assert.deepEqual(recipe.memory?.seed, { directory: join(recipeDir, 'seed') });
  assert.deepEqual(recipe.memory?.consumers, ['proposer']);
  assert.deepEqual(recipe.memory?.observe.steps, [
    'steps/search/steps/propose',
  ]);
  assert.equal(recipe.memory?.observe.bindings, undefined);
  assert.deepEqual(recipe.memory?.budget, {
    modelCalls: 0,
    evidenceBytes: 99,
    elapsedWallMs: 2000,
  });
  assert.equal(recipe.reflection?.goal, 'policy goal');
  assert.deepEqual(recipe.reflection?.observe.bindings, ['proposer', 'memory']);
  const artifacts = new FileArtifacts(join(root, 'artifacts'));
  const locked = await lockDefinition(
    recipe,
    registry,
    artifacts,
    join(root, 'locked'),
  );
  assert.equal(locked.schemaVersion, 'rsi.definition-lock/v3');
  assert.equal(
    readResourceOrigins(locked)._memory!['/seed/directory'],
    join(recipeDir, 'seed'),
  );
  assert.equal(
    readResourceOrigins(locked)._memory!['/config/goalFile'],
    join(policyDir, 'inherited.md'),
  );
  assert.equal(
    readResourceOrigins(locked)._memory!['/goalFile'],
    join(recipeDir, 'override.md'),
  );
  const memory = parseLockedMemory(locked.memory!);
  const reflection = parseLockedReflection(locked.reflection!);
  assert.equal(
    memory.seedArtifactRef,
    await artifacts.capture(join(recipeDir, 'seed')),
  );
  await rm(recipeDir, { recursive: true, force: true });
  await rm(policyDir, { recursive: true, force: true });
  const restored = await Recipe.fromJSON(locked.recipe, registry, {
    policy: recipe.policy,
    memory,
    reflection,
  });
  assert.equal(
    await readFile(string(object(restored.memory?.config.resources).b), 'utf8'),
    'recipe prompt',
  );
  assert.equal(
    await readFile(restored.reflection!.goalFile!, 'utf8'),
    'policy goal',
  );
  assert.equal(
    await readFile(join(restored.memory!.seed!.directory!, 'notes.md'), 'utf8'),
    'seed',
  );
});

test('Recipe-only attachment, disabled syntax checks, plugin switches and smart agent defaults', async (t) => {
  const { policy, load } = await fixture(t);
  assert.deepEqual(
    (
      await load({
        memory: { enabled: false, plugin: 'missing', goalFile: 'missing' },
      })
    ).disabledLearning,
    ['memory'],
  );
  await assert.rejects(
    load({ memory: { enabled: false, typo: true } }),
    /additional properties/,
  );
  const base = { plugin: 'memory.test', trigger: { afterPolicy: true } };
  assert.equal((await load({ memory: base })).memory?.plugin, 'memory.test');
  await assert.rejects(load({ memory: { plugin: 'memory.test' } }), /trigger/);
  await assert.rejects(
    load({
      reflection: { plugin: 'reflection.test', trigger: { afterPolicy: true } },
    }),
    /targets/,
  );
  await assert.rejects(
    load({ memory: { ...base, consumers: ['bad'] } }),
    /consumers/,
  );
  await assert.rejects(
    load({ memory: { ...base, observe: { bindings: ['bad'] } } }),
    /bindings/,
  );
  const invalidBudgets: JsonObject[] = [
    { timeoutSeconds: 0 },
    { timeoutSeconds: 2147484 },
    { modelCalls: -1 },
    { evidenceBytes: 0 },
    { evidenceBytes: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const budget of invalidBudgets)
    await assert.rejects(load({ memory: { ...base, budget } }), /budget/);
  object(policy.defaults).memory = {
    ...base,
    config: { resources: { a: './inherited.md' } },
    seed: { directory: './missing' },
  };
  const changed = await load({
    memory: { plugin: 'memory.other', seed: { fromExperiment: 'source' } },
  });
  assert.deepEqual(changed.memory?.config, {});
  assert.deepEqual(changed.memory?.seed, { fromExperiment: 'source' });
  delete object(policy.defaults).memory;
  const builtin = await load({ memory: { trigger: { afterPolicy: true } } });
  assert.equal(builtin.memory?.config.agentRef, 'backend');
  assert.ok(
    (await readFile(string(builtin.memory?.config.prompt), 'utf8')).trim(),
  );
  await assert.rejects(
    load({
      memory: {
        trigger: { afterPolicy: true },
        config: { agentRef: 'proposer' },
      },
    }),
    /agentRef/,
  );
});

test('trigger selectors resolve canonical and qualified paths, reject ambiguous or parallel targets, and validate lexical guards', () => {
  const mark = { id: 'mark', type: 'if', if: true, then: { steps: [] } };
  const loop = { id: 'search', type: 'loop', maxIterations: 1, steps: [mark] };
  const decl = {
    schemaVersion: 'rsi.policy/v1',
    id: 'scope',
    input_schema: { type: 'object' },
    output_schema: true,
    output: null,
    steps: [
      loop,
      {
        id: 'other',
        type: 'foreach',
        foreach: [],
        as: 'item',
        key: '${{ item }}',
        concurrency: 2,
        steps: [mark],
      },
    ],
  };
  const policy = new Policy(decl);
  assert.throws(
    () => resolveTriggerTarget(policy.flowIndex, 'mark'),
    /Ambiguous.*steps\/search.*steps\/other/,
  );
  assert.throws(
    () => compileTrigger({ afterStep: 'other/mark' }, policy.flowIndex),
    /parallel/,
  );
  assert.throws(
    () => compileTrigger({ afterIteration: 'search/mark' }, policy.flowIndex),
    /requires a loop/,
  );
  assert.throws(
    () =>
      compileTrigger(
        { afterStep: 'search', if: '${{ steps.other.output }}' },
        policy.flowIndex,
      ),
    /unavailable/,
  );
  assert.throws(
    () =>
      new Policy({
        ...decl,
        steps: [{ ...loop, while: '${{ memory.ref == null }}' }],
      }),
    /memory/,
  );
  assert.deepEqual(
    compileTrigger(
      { afterStep: 'search/mark', if: '${{ steps.mark.output == null }}' },
      policy.flowIndex,
    ),
    {
      afterStep: 'steps/search/steps/mark',
      if: '${{ steps.mark.output == null }}',
    },
  );
  assert.doesNotThrow(() =>
    compileTrigger(
      {
        afterIteration: 'search',
        if: '${{ loop.index == 0 && steps.mark.output == null }}',
      },
      policy.flowIndex,
    ),
  );
  assert.equal(
    matchesStepPath('steps/search/iteration-3/mark', 'steps/search/steps/mark'),
    true,
  );
  assert.equal(
    matchesStepPath(
      'steps/search/iteration-3/@iteration-0',
      'steps/search/steps/mark',
    ),
    false,
  );
});
test('resources inside external Policy learning declarations retain the directory of each referenced YAML file', async (t) => {
  const { policy, policyDir, recipeDir, load } = await fixture(t);
  const nested = join(policyDir, 'modules');
  await mkdir(nested);
  await writeFile(join(nested, 'prompt.md'), 'nested prompt');
  await writeFile(join(nested, 'goal.md'), 'nested goal');
  await writeFile(
    join(nested, 'learning.yaml'),
    JSON.stringify({
      module: {
        plugin: 'memory.test',
        trigger: { afterPolicy: true },
        goalFile: './goal.md',
        config: { resources: { a: './prompt.md', b: './missing.md' } },
      },
    }),
  );
  object(policy.defaults).memory = { $ref: 'modules/learning.yaml#/module' };
  const recipe = await load({
    memory: { config: { resources: { b: './override.md' } } },
  });
  assert.equal(recipe.memory?.goal, 'nested goal');
  assert.deepEqual(recipe.memory?.config.resources, {
    a: join(nested, 'prompt.md'),
    b: join(recipeDir, 'override.md'),
  });
});
