# Reflection guide

English | [简体中文](reflection_zh.md) · [Getting started](../getting-started.md)

Reflection proposes changes to selected resource files of optimizer plugins. The Runtime validates the proposed tree and activates accepted revisions for subsequent calls in the same experiment. Each call records the revision it acquired.

## Attach Reflection to a Policy

Declare `defaults.reflection` in a Policy or `reflection` at the top level of a Recipe. This example uses Harness² bindings. Its built-in module is disabled by default, so `reflection: { enabled: true }` is sufficient to use its packaged settings.

```yaml
reflection:
  enabled: true
  trigger: { afterIteration: search, skipFinal: true }
  observe: { bindings: [invariantProposer, domainProposer, composer] }
  targets:
    invariantProposer: { resources: [guidance] }
    domainProposer: { resources: [guidance] }
  goal: Preserve useful proposal strategies and qualify unsupported claims.
  evidenceView: execution
  budget: { timeoutSeconds: 3600 }
```

Parameter Agent also defaults to disabled. Its module observes search rounds and can revise the Proposer's guidance while another round remains. A Recipe can attach Reflection to another Policy by specifying that Policy's serial boundary and targets.

## Choose evidence, resources and limits

Select one or more triggers with `afterStep`, `afterIteration` or `afterPolicy: true`. Iteration triggers default to `skipFinal: true`. `observe.bindings` and `observe.steps` select calls since the previous boundary. `excludeSteps` excludes producer calls and prevents expansion of their measurements. When Memory is enabled, `memory` is available as an observed binding.

`execution` supplies execution observations. `training-summary` also permits authorized training feedback. The default projection includes available Agent traces, document previews, and comparisons between resource versions. `budget.modelCalls`, `timeoutSeconds`, and `evidenceBytes` limit each invocation. Experiment cancellation and budget limits apply throughout.

Each target identifies a configured binding and its editable resource fields. For a custom plugin, mark editable configuration fields with `x-rsi-path: file` or `x-rsi-path: directory`, configure their values in the binding, then list those field names under `targets.<binding>.resources`. The plugin should load those resources through its effective configuration. At activation the Runtime replaces the affected plugin instances and preserves their prior snapshots.

Select a `contract.reflection` implementation through `plugin`. The default `reflection.agent` reads the evidence index at `context/learning/index.json` and proposes changes against its authorized resource manifest. Override individual settings using `config.agentRef`, `config.prompt` and either inline `goal` or `goalFile`. Object settings merge recursively and arrays replace inherited arrays. Disabled declarations undergo syntax checking without probing learning resources.

## Apply a revision to future experiments

Runtime activation is local to one experiment. Preview file additions, replacements and deletions before writing a revision back to its user-owned source or exporting it elsewhere.

```sh
arsi reflection list <experiment-id>
arsi reflection show <revision-id> --to ./revised-guidance
arsi reflection apply <revision-id> --to ./revised-guidance
```

Omit `--to` to use the recorded source paths. Packaged resources require an external destination. A single directory resource maps directly to the export directory. The preview shows paths for file or multi-resource exports. Point future Recipe bindings at the exported files or directories. See the [Memory guide](memory.md) for experience snapshots.
