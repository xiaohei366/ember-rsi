# Memory guide

English | [简体中文](memory_zh.md) · [Getting started](../getting-started.md)

Memory consolidates experience into immutable file-tree snapshots. An authorized binding can read the snapshot active at the start of its call with `await ctx.readMemory()`. The result contains a version reference, artifact reference, and UTF-8 files. Calls without an authorized snapshot receive `null`.

## Attach Memory to a Policy

Declare `defaults.memory` in a Policy or `memory` at the top level of a Recipe. This Recipe excerpt uses the built-in WikiSkill step and binding names.

```yaml
memory:
  enabled: true
  trigger: { afterStep: train }
  observe:
    steps: [train, propose, select]
    excludeSteps: [baseline, validate, test]
    includeCandidateDiffs: true
    includeCandidateSources: true
  consumers: [proposer]
  evidenceView: training-summary
  budget: { modelCalls: 2, timeoutSeconds: 600 }
```

Harness² updates Memory after each task using execution evidence. WikiSkill updates it after training and before the Proposer runs. Parameter Agent enables it with `memory.enabled: true` and consolidates measured configurations after each search round. All three Policies use the same module declaration.

## Select evidence and consumers

Choose a serial boundary with `afterStep`, `afterIteration`, or `afterPolicy: true`. A declaration may list several triggers. `every` selects each Nth step completion or loop iteration. Iteration triggers accept `skipFinal`, which defaults to false for Memory. Use an optional `if` expression for conditional execution. When both learning modules share a boundary, Memory runs first.

`observe.bindings` and `observe.steps` form a union. `excludeSteps` removes calls and the measurements they produced from expansion. Names can be unique step IDs or distinguishing step paths. In the WikiSkill example the next update can see the previous selector's aggregate decision and the current training measurement. Individual validation and test results stay outside the evidence window.

The default `execution` view supplies verifier-blind execution evidence. Select `training-summary` for authorized training feedback. The built-in editor reads snapshots through `context/learning/index.json`. Enable `includeCandidateSources` when the editor needs candidate text. `includeBaseline` adds the original application candidate as a diff anchor.

When omitted, `consumers` defaults to the Policy's Proposer bindings. The built-in editor mounts the authorized files under `context/memory/` and lists them in `context/input.json`. A Policy can return the active snapshot ID with `${{ memory.ref }}`.

## Configure and reuse experience

Override individual nested fields in the Recipe. Arrays replace inherited arrays. Choose a plugin implementing `contract.memory` with `plugin`, and pass its settings under `config`. The default `memory.agent` uses a bundled prompt. Override it with `config.prompt`. Set `config.agentRef` when the Policy's Agent binding is ambiguous. Use inline `goal` or a relative `goalFile`. Each resource path is relative to the declaration that supplied it.

`budget.modelCalls`, `timeoutSeconds`, and `evidenceBytes` apply to one update. `editConstraints` limits allowed paths, changed files, and changed bytes. An ordinary rejected update preserves the prior snapshot. Experiment-wide limits and cancellation still apply.

New experiments start with empty Memory unless the declaration includes `seed: { directory: ./wiki }` or `seed: { fromExperiment: previous-id }`. The latter copies the active snapshot of a completed experiment. Preview the destination before applying a snapshot.

```sh
arsi memory list <experiment-id>
arsi memory show <memory-id> --to ./exported-wiki
arsi memory apply <memory-id> --to ./exported-wiki
```

When the original seed directory is user-owned, omitting `--to` uses that directory. Otherwise provide a dedicated export directory. The [Reflection guide](reflection.md) describes how to revise optimizer resource files.
