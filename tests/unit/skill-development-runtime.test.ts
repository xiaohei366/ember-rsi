import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { join } from 'node:path';
import {
  mkdtemp,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { createRuntime } from '../../src/runtime/context.js';
import { Policy } from '../../src/runtime/policy/index.js';
import {
  agentContract,
  type JsonObject,
  type AgentInput,
  type AgentOutput,
  type DevelopmentInput,
  type DevelopmentOutput,
} from '../../src/contracts/index.js';
import type { DevelopmentConfig } from '../../src/plugins/evaluator-development/schema.js';
import { developmentEvaluatorDefinition } from '../../src/plugins/evaluator-development/index.js';
import { createDevelopmentEvaluator } from '../../src/plugins/evaluator-development/service.js';
import { submitFeedback } from '../../src/plugins/human-review/service.js';
import { developmentFixture } from '../fixtures/development-fixture.js';
import { object, string } from '../../src/shared/json.js';

test('skill development is opt-in through the real extension loader and compiles registered contracts', async () => {
  const ordinary = await createRuntime({ homeDirectory: false });
  try {
    assert.equal(
      ordinary.registry.catalog().policies.includes('policy.skill-development'),
      false,
    );
    assert.equal(
      ordinary.registry.catalog().plugins.includes('evaluator.development'),
      false,
    );
  } finally {
    await ordinary.dispose();
  }
  const runtime = await createRuntime({
    homeDirectory: false,
    pluginDirectories: [resolve('src/extensions/skill-development')],
  });
  try {
    const catalog = runtime.registry.catalog();
    for (const plugin of [
      'evaluator.development',
      'proposer.skill',
      'human.review',
    ])
      assert.ok(catalog.plugins.includes(plugin));
    const policy = await Policy.load(
      runtime.registry.policy('policy.skill-development'),
      runtime.registry,
    );
    assert.equal(policy.id, 'policy.skill-development');
  } finally {
    await runtime.dispose();
  }
});

test(
  'real Runtime runs skill proposals, fresh development, human continuation and exact accepted export',
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rsi-development-runtime-'));
    const fixture = await developmentFixture(join(root, 'fixed'));
    fixture.state.developmentOutcomes = ['development-failure', 'pass', 'pass'];
    const baseline = join(root, 'candidate-baseline');
    await cp(resolve('skills/ember-rsi/assets/minimal/baseline'), baseline, {
      recursive: true,
    });
    await mkdir(join(baseline, 'skills/ember-rsi/assets'), { recursive: true });
    const original =
      '---\nname: ember-rsi\ndescription: Develop RSI Policies and plugins.\n---\n\nOriginal guidance.\n';
    await writeFile(join(baseline, 'skills/ember-rsi/SKILL.md'), original);
    await writeFile(
      join(baseline, 'skills/ember-rsi/assets/fixed.txt'),
      'Fixed support material\n',
    );
    const runtime = await createRuntime({
      rootDirectory: root,
      directory: join(root, '.rsi'),
      homeDirectory: false,
      pluginDirectories: [resolve('src/extensions/skill-development')],
    });
    const stop = new AbortController();
    let proposalCalls = 0;
    const selectedBases: string[] = [];
    runtime.registry.registerOperation<
      DevelopmentInput,
      DevelopmentOutput,
      DevelopmentConfig
    >({
      ...developmentEvaluatorDefinition,
      id: 'controlled.development',
      create: (config, context) =>
        createDevelopmentEvaluator(config, context, fixture.boundaries),
    });
    runtime.registry.registerOperation<AgentInput, AgentOutput, JsonObject>({
      id: 'controlled.agent',
      contract: agentContract,
      configSchema: { type: 'object', additionalProperties: false },
      async create() {
        return {
          async execute(request): Promise<JsonObject> {
            proposalCalls++;
            const input = object(request.input);
            const sources = input.sources;
            assert.ok(Array.isArray(sources));
            const baseCandidateRef = string(object(sources[0]).candidateRef);
            selectedBases.push(baseCandidateRef);
            assert.match(JSON.stringify(input.evidence), /developmentCost/);
            assert.match(JSON.stringify(input.evidence), /40/);
            if (proposalCalls === 2)
              assert.match(
                JSON.stringify(input.evidence),
                /Review original requirement/,
              );
            return {
              baseCandidateRef,
              baseReason: 'Use the original fixed documentation base.',
              reason: `Hypothesis ${proposalCalls}: validate public contracts before composing Policy flows.`,
              edits: [
                {
                  path: 'skills/ember-rsi/SKILL.md',
                  content: original + `\nGuidance revision ${proposalCalls}.\n`,
                },
              ],
            };
          },
          async dispose() {},
        };
      },
    });
    const recipe = join(root, 'recipe.yaml');
    await writeFile(
      recipe,
      stringify(
        {
          schemaVersion: 'rsi.recipe/v1',
          id: 'controlled-development',
          application: {
            plugin: 'application.agentbundle',
            config: {
              baseline: { directory: baseline },
              target: {
                schema: {
                  schemaVersion: 'rsi.target/v1',
                  id: 'skill-documents',
                  entries: [
                    {
                      path: 'skills/ember-rsi/SKILL.md',
                      kind: 'file',
                      description: 'Development guidance',
                      changes: ['modify'],
                    },
                  ],
                },
              },
            },
          },
          policy: { id: 'policy.skill-development', config: { maxRounds: 3 } },
          bindings: {
            agent: { plugin: 'controlled.agent', config: {} },
            evaluator: {
              plugin: 'controlled.development',
              config: fixture.config,
            },
            reviewer: {
              plugin: 'human.review',
              config: { waitTimeoutMs: 10000, pollIntervalMs: 5 },
            },
          },
          budget: { elapsedWallMs: 20000 },
        },
        { aliasDuplicateObjects: false },
      ),
    );
    const decisions = (async (): Promise<void> => {
      const responded = new Set<string>();
      while (responded.size < 2) {
        stop.signal.throwIfAborted();
        const directory = join(
          root,
          '.rsi/human-review/controlled-development',
        );
        let entries: string[] = [];
        try {
          entries = await readdir(directory);
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
        for (const id of entries) {
          if (responded.has(id)) continue;
          const requestDirectory = join(directory, id);
          let request: JsonObject;
          try {
            request = object(
              JSON.parse(
                await readFile(join(requestDirectory, 'request.json'), 'utf8'),
              ),
            );
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            )
              continue;
            throw error;
          }
          const action = responded.size === 0 ? 'continue' : 'accept';
          await submitFeedback(requestDirectory, {
            requestId: id,
            attemptId: request.attemptId,
            candidateRef: request.candidateRef,
            action,
            issues:
              action === 'continue'
                ? [
                    'Review original requirement: explain cancellation ownership.',
                  ]
                : [],
            explanation:
              'Controlled human decision at the external feedback boundary.',
          });
          responded.add(id);
        }
        if (responded.size < 2)
          await delay(5, undefined, { signal: stop.signal });
      }
    })();
    try {
      const [experiment] = await Promise.all([
        runtime.manager.run(recipe, { id: 'controlled-development' }),
        decisions,
      ]);
      assert.equal(experiment.status, 'succeeded');
      const output = object(experiment.output);
      assert.equal(output.status, 'accepted');
      assert.equal(output.attempts, 3);
      assert.equal(proposalCalls, 2);
      assert.equal(new Set(selectedBases).size, 1);
      assert.equal(fixture.state.developmentCalls, 3);
      assert.equal(fixture.state.acceptanceCalls, 2);
      assert.equal(fixture.state.suppliedSkills[0], original);
      assert.match(fixture.state.suppliedSkills[1], /Guidance revision 1/);
      assert.match(fixture.state.suppliedSkills[2], /Guidance revision 2/);
      assert.doesNotMatch(
        fixture.state.taskInstructions[1],
        /Review original requirement/,
      );
      assert.match(
        fixture.state.taskInstructions[2],
        /Review original requirement/,
      );
      const packageDirectory = join(root, 'exported');
      await runtime.manager.artifacts.materialize(
        string(output.packageRef),
        packageDirectory,
      );
      assert.match(
        await readFile(
          join(packageDirectory, 'skill/skills/ember-rsi/SKILL.md'),
          'utf8',
        ),
        /Guidance revision 2/,
      );
      assert.equal(
        await readFile(
          join(packageDirectory, 'skill/skills/ember-rsi/assets/fixed.txt'),
          'utf8',
        ),
        'Fixed support material\n',
      );
      assert.equal(
        await readFile(join(baseline, 'skills/ember-rsi/SKILL.md'), 'utf8'),
        original,
      );
      const receipts = await runtime.manager.facts.list('calls');
      assert.equal(
        receipts.some((receipt) => receipt.status !== 'succeeded'),
        false,
      );
      assert.equal((await runtime.manager.facts.list('candidates')).length, 3);
    } finally {
      stop.abort();
      await Promise.allSettled([decisions]);
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
