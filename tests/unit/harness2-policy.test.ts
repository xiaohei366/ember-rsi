import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { RuntimeContext, type JsonObject } from '../../src/contracts/index.js';
import { registerBuiltins } from '../../src/runtime/builtins.js';
import { Policy } from '../../src/runtime/compiler/index.js';
import type { PolicyOptions } from '../../src/runtime/policy/policy.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { object, string } from '../../src/shared/json.js';

test('Harness2 bounds concurrent INV and DOM phases and retains their paired evidence on resume', async (t) => {
  const registry = new Registry();
  t.after(() => registry.dispose());
  await registerBuiltins(registry);
  const policy = await Policy.load(
    'src/policies/harness2/policy.yaml',
    registry,
  );

  for (const concurrency of [undefined, 1]) {
    const k = concurrency === 1 ? 1 : 2;
    const slots = Array.from({ length: k }, (_, slot) => slot);
    const invariant = slots.map((slot) => ({
      candidateRef: `inv-${slot}`,
      measurementRef: `measurement-inv-${slot}`,
    }));
    const domain = slots.map((slot) => ({
      candidateRef: `dom-${slot}`,
      measurementRef: `measurement-dom-${slot}`,
    }));
    const started: string[] = [];
    const active = new Set<string>();
    const peak = new Map<string, number>();
    const selection = {
      candidateRef: 'composed-0',
      measurementRef: 'measurement-composed-0',
      decisionRef: 'decision',
    };
    let checkpoint: JsonObject = {};
    let interrupted = false;
    const options: PolicyOptions = {
      input: { candidateRef: 'base' },
      config: {
        k,
        ...(concurrency === undefined ? {} : { concurrency }),
        dataset: { taskIds: ['task'] },
      },
      application: {},
      context: new RuntimeContext().extend({ signal: t.signal }),
      checkpoint: async (value) => {
        checkpoint = value;
        if (
          concurrency === undefined &&
          !interrupted &&
          Object.hasOwn(
            object(value.journal),
            'steps/search/iteration-0/probes',
          )
        ) {
          interrupted = true;
          throw new Error('Interrupted after probes');
        }
      },
      invoke: async (name, raw, path): Promise<JsonObject> => {
        const value = object(raw);
        if (name === 'selector') return selection;
        if (name === 'memoryUpdater') {
          const probes = object(object(value.comparison).probes);
          assert.deepEqual(probes.invariant, invariant);
          assert.deepEqual(probes.domain, domain);
          assert.deepEqual(value.evidenceRefs, [
            ...slots.map((slot) => `measurement-base-${slot}`),
            ...[...invariant, ...domain].map((item) => item.measurementRef),
            ...slots.map((slot) => `measurement-composed-${slot}`),
          ]);
          return {
            status: 'no-change',
            memoryRef: null,
            changeRef: null,
            reason: '',
          };
        }
        if (name === 'evaluator') {
          assert.deepEqual(value.taskIds, ['task']);
          const candidate = string(value.candidateRef);
          if (candidate === 'base') {
            const slot = started.filter((entry) => entry === 'base').length;
            started.push('base');
            return { measurementRef: `measurement-base-${slot}` };
          }
          if (!candidate.startsWith('composed-')) {
            assert.equal(
              started.filter((entry) => entry === 'proposals').length,
              2 * k,
            );
            assert.match(
              path,
              candidate.startsWith('inv-')
                ? /\/execute_inv$/
                : /\/execute_dom$/,
            );
            assert.ok([...active].every((entry) => entry.startsWith('probe:')));
            active.add(`probe:${candidate}`);
            peak.set('probes', Math.max(peak.get('probes') ?? 0, active.size));
            started.push('probes');
            await setImmediate();
            active.delete(`probe:${candidate}`);
          }
          return { measurementRef: `measurement-${candidate}` };
        }
        assert.equal(value.parent, 'base');
        const [evidence] = value.evidenceRefs as string[];
        const slot = string(evidence).split('-').at(-1);
        if (name === 'composer') {
          assert.equal(
            started.filter((entry) => entry === 'probes').length,
            2 * k,
          );
          assert.equal(active.size, 0);
          assert.deepEqual(value.sources, [...invariant, ...domain]);
          return {
            status: 'created',
            candidateRef: `composed-${slot}`,
            diffRef: 'diff',
            rationale: '',
          };
        }
        const candidateRef =
          name === 'invariantProposer' ? `inv-${slot}` : `dom-${slot}`;
        assert.ok(name === 'invariantProposer' || name === 'domainProposer');
        assert.equal(started.filter((entry) => entry === 'base').length, k);
        assert.match(string(evidence), /^measurement-base-\d+$/);
        active.add(candidateRef);
        peak.set(
          'proposals',
          Math.max(peak.get('proposals') ?? 0, active.size),
        );
        started.push('proposals');
        await setImmediate();
        active.delete(candidateRef);
        return {
          status: 'created',
          candidateRef,
          diffRef: 'diff',
          rationale: '',
        };
      },
    };

    if (concurrency === undefined)
      await assert.rejects(policy.execute(options), /Interrupted after probes/);
    const output = await policy.execute({
      ...options,
      ...(interrupted ? { restore: checkpoint } : {}),
    });
    assert.deepEqual(output, { baseline: 'base', deliveries: [selection] });
    assert.equal(peak.get('proposals'), concurrency ?? 2);
    assert.equal(peak.get('probes'), concurrency ?? 2);
  }
});
