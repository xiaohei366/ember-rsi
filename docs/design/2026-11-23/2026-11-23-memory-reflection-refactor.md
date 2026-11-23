# Built-in Memory and Reflection Plugin Refactor

- **Date**: 2026-11-23
- **Status**: Finalized (ready for implementation)

## 1. Background and Goals

This design defines the refactor of the built-in Memory (`memory.agent`) and Reflection (`reflection.agent`) mechanisms and their Runtime, EventPipeline, Policy, Recipe, CLI, and Dashboard integration.

Core goals:

1. **User-controlled Memory retention**: Give Memory the same explicit retention workflow that Reflection provides, allowing users to inspect learned experience produced during an experiment and explicitly decide whether to write it back to user-owned files for future runs.
2. **Low-friction defaults without losing flexibility**:
   - Make both Memory and Reflection **enabled by default** with zero required configuration or Policy boilerplate.
   - Eliminate the split where Policies had to manage trigger points (and Memory `memoryRef` state plumbing) while external config files managed runtime settings.
   - Keep full configurability via optional external `memory.yaml` / `reflection.yaml` files with symmetric structure and optional fields.
3. **Event-centric Runtime decoupling**: Build triggering, Agent Memory injection, and activation broadcast natively on the framework's existing Cordis `EventPipeline` ([events.ts](../../../src/contracts/runtime/events.ts), [services/events.ts](../../../src/runtime/services/events.ts)) without bloating `RuntimeContext` or coupling Policy execution to Memory/Reflection internals.

## 2. Verified Current Baseline

Before this refactor, Memory and Reflection use two divergent architectures:

| Aspect | Reflection (Current) | Memory (Current) |
| --- | --- | --- |
| Invocation in Policy | Dedicated `type: reflection` step ([steps.ts](../../../src/runtime/policy/steps.ts)) | Ordinary `type: invoke` calling a `contract.memory` binding ([memory.ts](../../../src/contracts/plugin-types/memory.ts)) |
| Configuration | External `reflection.yaml` via Policy `defaults.reflection.configFile` or Recipe `reflection.configFile` (mandatory fields, full-file replacement only) ([declaration.ts](../../../src/runtime/revisions/declaration.ts), [validation.ts](../../../src/runtime/revisions/validation.ts)) | Policy `require` + `defaults.bindings` + per-Policy `config.memory` switches and inline `with:` arguments ([policy.yaml](../../../src/policies/harness2/policy.yaml)) |
| State & Data Passing | Runtime-managed. Target plugins declare `x-rsi-path` resources; Runtime swaps active revisions transparently via [activation.ts](../../../src/runtime/manager/activation.ts) and emits `rsi/revision-activated`. | Policy-managed. Policy declares `state.memoryRef` / `state.wikiRef`, writes it back via `type: state`, and threads `memoryRef` into `ProposerInput` ([proposer.ts](../../../src/contracts/plugin-types/proposer.ts)). |
| Evidence Input | Runtime automatically collects a bounded window of calls from configured `evidence` bindings ([evidence.ts](../../../src/runtime/revisions/evidence.ts)). | Policy manually assembles `evidenceRefs`, `comparison`, `observations`, and `sources` in `with:`. |
| Persistence / Retention | Immutable snapshots in `.rsi/facts/revisions` and `.rsi/artifacts/`; users explicitly preview and apply to user-owned paths via `arsi reflection list/show/apply` or Web Dashboard ([application.ts](../../../src/runtime/revisions/application.ts)). | Ephemeral per-experiment artifact ref (`memoryRef` starts as `null` every run). No user-owned source directory or `list/show/apply` retention workflow. |

## 3. Confirmed Architectural Decisions

1. **Foundational Resource Model (Topic 1)**:
   - Model **Memory** as a **first-class Runtime-managed shared Memory Store** (single logical shared experience store per experiment, one-writer / multi-reader, allowed to start empty).
   - Keep **Reflection** focused on evolving *plugin-owned private resources* (declared via `x-rsi-path` in plugin config schemas).
   - Share one underlying Runtime substrate for immutable snapshot storage, version chains, and safe filesystem write-back, while keeping Memory and Reflection semantics distinct at the upper layer.
2. **Retention & Cross-Experiment Lifecycle (Topic 2)**:
   - Canonical Memory source is a **user-owned directory** (e.g. `./memory`). When configured, experiment startup snapshots it as the initial Memory (an empty or nonexistent directory starts from an empty tree).
   - **Zero-config startup**: Experiments may run without configuring a directory (starting empty). Generated Memory snapshots are still persisted in `.rsi/`, and users may explicitly export/apply any snapshot to a chosen user-owned destination (`--to <dir>` in CLI or destination input in Dashboard) under the same safety validations.
   - **Atomic whole-snapshot explicit retention**: Identical to Reflection — user source directories are never mutated during an experiment; users explicitly preview and apply a complete snapshot (`list` / `show` / `apply` in CLI and Dashboard) to preserve cross-file consistency.
3. **Eliminating `memoryRef` Plumbing & Event-Centric Collaboration (Topic 3 + Event Architecture)**:
   - Remove `memoryRef` from Policies and from `ProposerInput`, and do **not** add `readMemory()` to `RuntimeContext`.
   - Runtime owns the experiment's active Memory version pointer (persisted alongside activations for resume/recovery).
   - All Memory/Reflection runtime integration flows natively through Cordis `EventPipeline`:
     - **Triggering**: Subscribe to `rsi/policy-boundary-completed` (`@mode serial`).
     - **Agent Memory delivery**: Subscribe to a new `rsi/before-agent-invoke` (`@mode waterfall`) using Cordis's native **return-value onion chain** (never mutating isolated listener `ctx`).
     - **Activation broadcast**: Emit `rsi/memory-activated` (`@mode emit`), symmetric with Reflection's existing `rsi/revision-activated`.
   - Both Memory and Reflection follow a **default-open + optional restriction** model.
4. **Configuration Surface & Scope Controls (Topic 4)**:
   - Both Memory and Reflection are **enabled by default**.
   - Policy `defaults` and Recipe expose only a boolean toggle (`true` / `false`) and an optional external `configFile` pointer — **no inline configuration objects** in Policy or Recipe.
   - Inside `memory.yaml` and `reflection.yaml`, **every field is optional** and falls back to built-in defaults.
   - Both `targets` and `evidence` default to open (for Reflection `targets`, all `x-rsi-path` resources across eligible bindings) and both provide explicit restriction controls (`include` / `exclude`).
   - Use the unified field name **`targets`** in both `memory.yaml` and `reflection.yaml`.
5. **Triggering Mechanism (Topic 5)**:
   - Triggering is owned **entirely by Runtime event subscriptions and config files** — **zero** `type: reflection` or Memory invocation steps in Policies.
   - Default trigger: end of each **top-level `loop` iteration** (falling back to **`experiment-end`** when a Policy has no top-level loop).
   - Config files may customize trigger boundaries (`loop-iteration`, `loop-end`, `experiment-end`, `after-step`) and cadence (`every: N`).
   - When both Memory and Reflection trigger at the same boundary, **Memory runs first, then Reflection**, both serially outside parallel branches.
6. **Unified Evidence Collection (Topic 6)**:
   - Memory and Reflection share one Runtime evidence-window collector capturing calls, candidate lineage/diffs, `evidenceView`-projected measurements, and selector decisions between consecutive boundaries.
   - Retire Policy-assembled `comparison`, `observations`, and `sources`.
   - Fine-grained isolation (e.g. excluding holdout `validate`/`test` steps or `promotion` bindings) is configured declaratively under `evidence` via binding and step-ID allowlists/denylists and `evidenceView` (`execution` vs. `training-summary`). No Policy `state` expressions in config files.
7. **Default Agent & Breaking Cleanup Boundary (Topic 7)**:
   - When `implementation.config.agentRef` is omitted, Runtime directly synthesizes an internal built-in **`agent.pi`** instance using `agent.pi` schema defaults (`${MODEL_NAME}`, `${MODEL_ENDPOINT}`, `${MODEL_API_KEY}`). To reuse a Policy/Recipe `contract.agent` binding instead, specify `implementation.config.agentRef` explicitly in `memory.yaml` / `reflection.yaml`.
   - **Clean removal**: Do not retain legacy parsers or dual paths. Remove `type: reflection` Policy steps, `ProposerInput.memoryRef`, legacy `MemoryInput` fields (`memoryRef`, `comparison`, `observations`, `sources`), and mandatory legacy `reflection.yaml` rules; migrate all built-in Policies, example Recipes, unit tests, and EN/ZH guides together.

## 4. Target Specification

### 4.1 Policy and Recipe Declaration Surface

Both Policy `defaults` and Recipe top-level accept symmetric `memory` and `reflection` declarations:

```yaml
# Omitted => default enabled with built-in defaults (or Policy defaults in Recipe)
memory: false                      # explicitly disabled
memory: true                       # explicitly enabled (e.g. overriding Policy default false)
memory:
  configFile: ./memory.yaml        # enabled with external config file

reflection: false
reflection: true
reflection:
  configFile: ./reflection.yaml
```

Resolution and precedence rules:

1. **Built-in baseline**: `{ enabled: true }` with built-in defaults.
2. **Policy `defaults.{memory,reflection}`**: Overrides built-in baseline (e.g., pure numeric Policies such as `policy.parameter-grid` and `policy.parameter-optuna` set `memory: false` and `reflection: false`; domain Policies may attach a default `configFile` such as `./memory.yaml` / `./reflection.yaml`).
3. **Recipe `{memory,reflection}`**: Overrides Policy `defaults`:
   - `false`: Disables the capability for this experiment (no `configFile` loaded or validated; no Runtime event listeners registered).
   - `true`: Enables the capability. If Policy declared a `configFile`, that Policy `configFile` remains active; if Policy disabled it, built-in defaults apply.
   - `{ configFile: <path> }`: Enables the capability using the Recipe-relative config file (replaces any Policy `configFile`; omitted fields inside the file fall back to built-in defaults).

### 4.2 Unified `memory.yaml` and `reflection.yaml` Schema

All fields in both files are optional and share a symmetric vocabulary:

```yaml
# memory.yaml
directory: ./memory                # Memory only: user-owned source directory (relative to configFile); omitted => start empty
trigger:
  on: loop-iteration               # loop-iteration (default) | loop-end | experiment-end | after-step
  step: train                      # required iff on == 'after-step'
  every: 1                         # positive integer >= 1 (default: 1)
evidence:
  view: execution                  # execution (default) | training-summary
  includeBindings: []              # optional allowlist of Policy binding names
  excludeBindings: []              # optional denylist of Policy binding names
  includeSteps: []                 # optional allowlist of Policy step IDs
  excludeSteps: []                 # optional denylist of Policy step IDs
targets:                           # Memory injection scope (default: all Agent-calling Policy bindings)
  include: []                      # optional allowlist of Policy binding names
  exclude: []                      # optional denylist of Policy binding names
goal: ./memory-goal.md             # optional UTF-8 goal file (default: built-in generic Memory goal)
implementation:                    # optional (default: contract.memory + memory.agent)
  contract: contract.memory
  ref: memory.agent
  config:
    agentRef: agent                # optional; omitted => Runtime synthesizes built-in agent.pi
    prompt: ./memory.md            # optional (default: built-in Memory prompt)
budget:                            # optional per-invocation local budget
  modelCalls: 10
  timeoutSeconds: 1800
  evidenceBytes: 131072
```

```yaml
# reflection.yaml
trigger:
  on: loop-iteration               # loop-iteration (default) | loop-end | experiment-end | after-step
  step: select                     # required iff on == 'after-step'
  every: 1                         # positive integer >= 1 (default: 1)
evidence:
  view: execution                  # execution (default) | training-summary
  includeBindings: []              # optional allowlist
  excludeBindings: []              # optional denylist
  includeSteps: []                 # optional allowlist
  excludeSteps: []                 # optional denylist
targets:                           # Reflection editable scope (default: all x-rsi-path resources on all eligible bindings)
  include:                         # optional allowlist: binding -> resource list (or ['*'] / omitted for all x-rsi-path fields)
    invariantProposer: [guidance]
  exclude:                         # optional denylist: binding -> resource list (or '*' for entire binding)
    composer: [prompt]
goal: ./reflection-goal.md         # optional UTF-8 goal file (default: built-in generic Reflection goal)
implementation:                    # optional (default: contract.reflection + reflection.agent)
  contract: contract.reflection
  ref: reflection.agent
  config:
    agentRef: agent                # optional; omitted => Runtime synthesizes built-in agent.pi
    prompt: ./reflection-prompt.md # optional (default: built-in Reflection prompt)
budget:
  modelCalls: 10
  timeoutSeconds: 3600
  evidenceBytes: 131072
```

Validation rules:

- `include*` and `exclude*` within each filter dimension (`includeBindings`/`excludeBindings`, `includeSteps`/`excludeSteps`, `targets.include`/`targets.exclude`) reject unknown binding, step, or resource names early at load time.
- `trigger.on: after-step` validates at Recipe load time that `trigger.step` matches a declared step ID in the Policy and is **not** inside a parallel `foreach` branch.
- When `memory.directory` is specified, Runtime validates the path against protected roots/symlinks at load time; a nonexistent directory is permitted as an initial empty Memory store, while an existing non-directory file or symlink is rejected.
- For Reflection's default-open `targets`, Runtime discovers all configured `x-rsi-path` fields on Policy bindings (excluding internal/synthetic bindings) and rejects overlapping editable destinations.

### 4.3 Event-Centric Runtime Protocol (Native Cordis `EventPipeline`)

In `@deepseek-ai/cordis` (`Events.waterfall`), `next()` takes **no arguments** and always forwards original dispatch arguments while propagating transformed values **upward through return values**. Furthermore, `ManagedEvents` ([services/events.ts](../../../src/runtime/services/events.ts)) creates an isolated per-listener `RuntimeContext` for every handler invocation, so mutating `ctx` inside a listener cannot reach downstream listeners or the caller. Accordingly, all `waterfall` hooks pass data exclusively via their **return values**, consumed by `Manager`:

1. **Boundary Triggering — Extend `rsi/policy-boundary-completed` (`@mode serial`)**:
   - Extend `PolicyBoundaryCompletedEvent` ([events.ts](../../../src/contracts/runtime/events.ts)) to cover all four serial boundaries:
     ```ts
     export interface PolicyBoundaryCompletedEvent extends PolicyEventInfo {
       readonly boundary:
         | 'iteration-completed'
         | 'loop-completed'
         | 'step-completed'
         | 'policy-completed';
       readonly iteration?: number;
       readonly stepId?: string;
       readonly stepPath?: string;
       readonly hasTopLevelLoop?: boolean;
     }
     ```
   - Policy executor only emits standard boundary events and has zero knowledge of Memory or Reflection.
   - Runtime registers internal event subscribers in deterministic order (**Memory subscriber first, then Reflection subscriber**). Each subscriber checks its `trigger` config (`on`, `step`, `every`) and checkpointed hit counter before running.
2. **Agent Memory Delivery — Add `rsi/before-agent-invoke` (`@mode waterfall`)**:
   - Dispatched in `Manager.invokeAgent` **before** entering `calls.invoke(agentRef, ...)` (so transformed `AgentInput.cwd` cleanly satisfies `calls.ts`'s `agent-projects/<sha256>/project` ownership and replay-key invariants):
     ```ts
     export interface BeforeAgentInvokeEvent {
       readonly experimentId: string;
       readonly callerBindingId: string;
       readonly callerDirectory: string;
       readonly agentRef: string;
       readonly input: AgentInput;
     }
     export type BeforeAgentInvokeResult =
       | { kind: 'proceed'; input: AgentInput; metadata?: JsonObject }
       | { kind: 'reject'; reason: string };
     ```
   - Innermost callback returns `async () => ({ kind: 'proceed', input })`.
   - Listeners compose via Cordis's onion pattern (`const current = await next(); if (current.kind !== 'proceed') return current; return { kind: 'proceed', input: transformed, metadata: { ...current.metadata, ... } };`), or veto by returning `{ kind: 'reject', reason }`.
   - Flexibility is preserved at two layers: `memory.targets` (`include`/`exclude`) restricts which bindings receive Memory, and custom listeners on `rsi/before-agent-invoke` can further transform, summarize, filter, or override injected Agent context without forced rigidity.
3. **Call Admission Alignment — `rsi/before-call` (`@mode waterfall`)**:
   - Align `CallDecision` with the same return-value style:
     ```ts
     export type CallDecision =
       | { kind: 'proceed'; metadata?: JsonObject }
       | { kind: 'reject'; reason: string };
     ```
   - Any optional read-only audit/extension metadata returned by `rsi/before-call` listeners is consumed directly by `Manager` rather than mutating `ctx`.
4. **Activation Broadcast — Add `rsi/memory-activated` (`@mode emit`)**:
   - Symmetric with Reflection's existing `rsi/revision-activated` ([events.ts](../../../src/contracts/runtime/events.ts)):
     ```ts
     export interface MemoryActivatedEvent {
       readonly experimentId: string;
       readonly activationId: string;
       readonly memoryVersionRef: string;
       readonly artifactRef: string;
     }
     ```
   - Emitted whenever Memory commits and activates a new snapshot, for telemetry, Dashboard observation, and external subscribers. (Observational broadcast only; delivery to Agent plugins is handled at call time by `rsi/before-agent-invoke`.)

### 4.4 Shared Evidence Window Collector

Generalize [evidence.ts](../../../src/runtime/revisions/evidence.ts) and [evidence-window.ts](../../../src/runtime/revisions/evidence-window.ts) into a shared Runtime evidence collector parameterized by consumer kind (`memory` | `reflection`) and `evidence` config:

- **Independent watermarks**: Memory and Reflection each track their own last-completed boundary watermark independently so differing cadences never interfere.
- **Window contents**:
  - Call receipts completed in the window matching `evidence` binding and step-ID filters (automatically excluding synthetic self-calls; Reflection observes Memory update records by default).
  - Referenced measurement evidence projected strictly under `evidence.view` (`execution` vs. `training-summary`).
  - Candidate snapshots and compact diffs derived from `candidates` facts referenced by calls in the window (replacing Harness²'s manual `comparison` builder with a generic Runtime diff/contrast summary).
  - Artifact/metric selector decision records referenced by calls in the window.
- **Skip on empty window**: If a window contains no usable observations, record `skipped` without invoking the generator plugin.

### 4.5 Symmetric Plugin Contracts

- **`contract.memory`** ([memory.ts](../../../src/contracts/plugin-types/memory.ts)):
  - Input: `{ parentVersionRef: string | null; resourceRef: string | null; goal: string; evidenceRefs: string[]; editConstraints: JsonObject }`
  - Output:
    - `{ status: 'updated'; resourceRef: string; changeRef: string; reason: string }`
    - `{ status: 'no-change'; resourceRef: string | null; changeRef: null; reason: string }`
  - `memory.agent` reads the Runtime-prepared `evidence-views` snapshot (same format as `reflection.agent`) and edits the Memory file tree via `editResource`.
- **`contract.reflection`** ([reflection.ts](../../../src/contracts/plugin-types/reflection.ts)):
  - Retains its existing symmetric shape (`parentRevisionRefs`, `resourceRef`, `goal`, `evidenceRefs`, `editConstraints` -> `proposed` | `no-change`).
- **`contract.proposer`** ([proposer.ts](../../../src/contracts/plugin-types/proposer.ts)):
  - Remove `memoryRef` from `ProposerInput` and `singleProposerInputSchema`.
  - No `readMemory()` method on `RuntimeContext`; all Agent-backed plugins receive Memory transparently through `rsi/before-agent-invoke`.

### 4.6 Unified Snapshot Inspection and Safe Write-Back (CLI & Dashboard)

Extract the filesystem safety & write-back core from [application.ts](../../../src/runtime/revisions/application.ts) into a shared snapshot application service used by both Reflection revisions and Memory versions:

- **Safety invariants (shared by both)**:
  - Block `apply` while any experiment in `.rsi/` is active or unresolved (resource gate + `blockingExperiments`).
  - Reject protected roots (`.rsi`, `.git`, `dist`, `node_modules`, RSI package `src/policies` / `src/plugins`, filesystem/project roots) and symbolic links/junctions.
  - Whole-snapshot atomic replacement (temp file + rename, remove files absent from snapshot, preserve non-executable text modes).
- **Destination resolution for Memory**:
  - If the experiment had a configured `directory`, `show` and `apply` target that recorded `sourceDirectory` by default (identical to Reflection).
  - If the experiment started zero-config (`sourceDirectory: null`), `show` / `apply` accept an explicit destination directory (`--to <dir>` in CLI; `targetDir` in Dashboard API), validated through the exact same protected-path and symlink safety checks.
- **CLI surface** ([commands.ts](../../../src/entries/cli/commands.ts)):
  - `arsi reflection list [experiment-id]` / `show <revisionID>` / `apply <revisionID>`
  - `arsi memory list [experiment-id]` / `show <versionID> [--to <dir>]` / `apply <versionID> [--to <dir>]`
- **Web Dashboard & HTTP API** ([learning.ts](../../../src/entries/web/learning.ts), `web/`):
  - `GET /api/observation/experiments/:id/memories/:ref/application?targetDir=...`
  - `POST /api/experiments/:id/memories/:ref/apply` (optional JSON body `{ targetDir?: string }`)
  - Add `Preview application` / `Apply to source files` dialog in **Reflection & Memory → Memory**, including a destination path input when the experiment ran without a pre-configured `directory`.

### 4.7 Built-in Defaults

- **Default Agent resolution**:
  1. Explicit `implementation.config.agentRef` in `memory.yaml` / `reflection.yaml` (must reference a declared `contract.agent` binding in the Policy/Recipe).
  2. Omitted: Runtime directly synthesizes an internal built-in `agent.pi` instance using its schema defaults (`model: ${MODEL_NAME}`, `base_url: ${MODEL_ENDPOINT}`, `api_key: ${MODEL_API_KEY}`).
- **Default prompts and goals**:
  - Ship a generic built-in `prompt.md` and `goal.md` inside `src/plugins/memory-agent/` (mirroring `src/plugins/reflection-agent/prompt.md` and `goals/generic/prompt.md`), so both Memory and Reflection work out of the box with zero configuration.

## 5. Cleanup and Migration Scope

No legacy compatibility layers will be retained:

1. **Remove obsolete Policy / Contract / Runtime features**:
   - Remove `ReflectionStep` (`type: reflection`) from [steps.ts](../../../src/runtime/policy/steps.ts) and Policy compiler/validator.
   - Remove `memoryRef` from [proposer.ts](../../../src/contracts/plugin-types/proposer.ts) and [agent-editing/index.ts](../../../src/plugins/shared/agent-editing/index.ts).
   - Remove `memoryRef`, `comparison`, `observations`, and `sources` from [memory.ts](../../../src/contracts/plugin-types/memory.ts) and delete [comparison.ts](../../../src/plugins/memory-agent/comparison.ts).
   - Replace `reflectionConfigFile` single-form declaration with the unified `boolean | { configFile }` parser for both `memory` and `reflection`.
2. **Migrate all built-in Policies & example Recipes**:
   - `policy.harness2`: Remove `state.wikiRef`, `require.memoryUpdater`, `remember_if_enabled` steps, `config.memory`, `memoryRef` args, and commented `type: reflection` step; update `defaults.{memory,reflection}` and `memory.yaml` / `reflection.yaml` (preserving `evidence.view: execution` and e.g. `targets: { exclude: [selector] }` if anonymous delivery selection should not see Memory).
   - `policy.wikiskill` & `policy.gym-rsi`: Remove `state.wikiRef`, `require.memoryUpdater`, `remember`/`save_memory` steps, `memoryRef` args, and `memoryRef` from output schemas; configure `memory.yaml` with `trigger: { on: after-step, step: train }` and `evidence: { view: training-summary, excludeSteps: [validate, test, promotion] }`.
   - `policy.parameter-agent`: Remove `state.memoryRef`, `config.memory`, `config.reflection`, `remember_if_enabled`, `reflect_if_enabled`, and `memoryRef` from output schema; configure `defaults.{memory,reflection}` with `evidence.view: training-summary`.
   - `policy.parameter-grid`, `policy.parameter-optuna`: Explicitly set `defaults: { memory: false, reflection: false }`.
   - `policy.gepa`, `policy.operator-search`: Remain enabled by default (no explicit opt-out in `defaults`), inheriting built-in Memory and Reflection defaults out of the box.
   - Update `examples/` Recipes accordingly.
3. **Update tests and user documentation**:
   - Update unit tests in `tests/unit/` and synchronize EN/ZH guides under `docs/users/guides/`.

## 6. Detailed Implementation Blueprint

### 6.1 Contracts, Events, and Configuration Loading

- **Contracts & Events (`src/contracts/`)**:
  - Update `RecipeDeclaration` ([recipe.ts](../../../src/contracts/recipe.ts)) and Policy `defaults` to accept `memory` and `reflection` as `boolean | { configFile: string }`.
  - Redefine `contract.memory` ([memory.ts](../../../src/contracts/plugin-types/memory.ts)) symmetrically with `contract.reflection`; remove `memoryRef`, `comparison`, `observations`, and `sources`.
  - Remove `memoryRef` from `contract.proposer` ([proposer.ts](../../../src/contracts/plugin-types/proposer.ts)); keep `RuntimeContext` clean (no `readMemory()`).
  - Update [events.ts](../../../src/contracts/runtime/events.ts): extend `PolicyBoundaryCompletedEvent` (`iteration-completed`, `loop-completed`, `step-completed`, `policy-completed`), add `rsi/before-agent-invoke` (`@mode waterfall`), align `CallDecision` with optional `metadata?: JsonObject`, and add `rsi/memory-activated` (`@mode emit`, added to `ordinaryNotifications` in [services/events.ts](../../../src/runtime/services/events.ts)).
- **Compiler & Loaders (`src/runtime/policy/`, `src/runtime/compiler/`, `src/runtime/loaders/`)**:
  - Remove `ReflectionStep` (`type: reflection`) from Policy parsing, validation, execution, and structure queries.
  - Implement one shared loader/validator for `memory.yaml` and `reflection.yaml` where all fields are optional; skip loading when resolved state is `false`.
  - Statically validate referenced bindings, step IDs, and `x-rsi-path` resources; validate that `trigger.on: after-step` targets an existing serial step outside parallel `foreach` branches.
- **Built-in `agent.pi` synthesis & definition lock (`src/runtime/manager/definition-lock.ts`)**:
  - When `implementation.config.agentRef` is omitted, synthesize an internal `agent.pi` binding using `agent.pi` schema defaults at load time.
  - Lock resolved Memory and Reflection configurations (including digests and synthesized `agent.pi` settings) in `definition-lock` so `--resume` guarantees configuration consistency.

### 6.2 Shared Evidence Window Collector

- **Generalize [evidence.ts](../../../src/runtime/revisions/evidence.ts) and [evidence-window.ts](../../../src/runtime/revisions/evidence-window.ts)** into a shared collector parameterized by consumer kind (`memory` | `reflection`) and `evidence` config:
  - **Independent watermarks**: Memory and Reflection each track their own last-completed boundary watermark independently, capturing only calls completed between consecutive boundaries of that capability.
  - **Filtering & leakage prevention**: Open by default across all Policy bindings (excluding synthetic self-calls; Reflection observes Memory update records by default). Apply optional `includeBindings` / `excludeBindings` and `includeSteps` / `excludeSteps` (matched against binding names and step IDs in `stepPath`).
  - **View isolation & automatic contrast summary**: Project referenced measurements strictly under `evidence.view` (`execution` vs. `training-summary`). Derive compact candidate diffs against baseline/parent candidates from `candidates` facts in the window alongside referenced `selector` decisions, replacing legacy manual `comparison` payloads. Persist as a read-only `evidence-views` snapshot.
  - **Empty-window skip**: Record `skipped` without invoking the plugin/model when no usable observations exist in the window.

### 6.3 Runtime Memory Lifecycle & Event-Driven Delivery (`rsi/before-agent-invoke`)

- **Initialization & immutable version chain (`memory-revisions`)**:
  - At experiment startup (when Memory is enabled), snapshot the configured `directory` (or an empty file tree if omitted, empty, or nonexistent) as a `kind: 'initial'` memory revision record storing `sourceDirectory: string | null` and `resourceRef`.
  - On each `status: 'updated'` Memory run, validate the resulting file tree (valid UTF-8 text, no path escape, no symlinks, no executable bits), persist an immutable snapshot and `kind: 'generated'` record (`parentRef`, `rootRef`, `changeRef`, `reason`), atomically advance the experiment's active Memory pointer, and emit `rsi/memory-activated`.
- **Active pointer persistence & `--resume`**:
  - Persist the active Memory version pointer alongside experiment activation facts (symmetric with `RevisionActivation`) so `--resume` restores the exact last active Memory version.
- **How target plugins consume outputs (verified across all built-in plugins)**:
  - **Reflection**: Runtime rewrites target `x-rsi-path` config fields to materialized revision paths, recreates plugin instances via `create(newConfig)`, hot-swaps them, and emits `rsi/revision-activated` — plugins consume revised resources transparently.
  - **Memory (Cordis `waterfall` delivery via `rsi/before-agent-invoke`)**:
    - Verified: every existing Agent-backed business plugin (`proposer.agent`, `selector.artifact`, `proposer.operator`, `summarizer.operator`) invokes `contract.agent` exclusively via `context.invokeAgent` ([manager/index.ts](../../../src/runtime/manager/index.ts)).
    - Before entering `calls.invoke(agentRef, ...)`, `Manager.invokeAgent` runs `ctx.event.waterfall('rsi/before-agent-invoke', event, async () => ({ kind: 'proceed', input }))`.
    - When Memory is enabled, its internal `rsi/before-agent-invoke` subscriber runs `const current = await next()`; if `current.kind === 'proceed'`, calling binding is authorized by `memory.targets` (excluding Memory/Reflection internal runs), and active Memory is non-empty, it performs the 4-step injection and returns `{ kind: 'proceed', input: { ...current.input, cwd: derivedCwd }, metadata: { ...current.metadata, memoryVersionRef } }`:
      1. **Derive a content-addressed workspace (`derivedCwd`)**: Never mutate `current.input.cwd`; stage a copy preserving `.rsi-project` and publish it at `callerDirectory/agent-projects/<sha256>/project` so all 5 Agent backends (`agent-pi`, `codex`, `claudecode`, `dsh`, `opencode`) keep their `cwd` sandbox and `calls.ts`'s strict project-ownership & replay-key validation passes unmodified.
      2. **Materialize active Memory under `derivedCwd/context/memory/`**: Write the pinned immutable Memory file tree into the reserved read-only `context/memory/` directory (rejecting path shadowing if already occupied).
      3. **Append read-only notice to `AGENTS.md` and `CLAUDE.md`**: Append a concise `## Experiment Memory (Read-Only)` section listing files under `context/memory/`, instructing the Agent to consult them before acting and never treat them as editable candidate targets.
      4. **Return transformed `AgentInput` & receipt metadata**: Return the new `input` and `{ memoryVersionRef }` to `Manager` through the `waterfall` return value; `Manager` forwards `result.input` to `calls.invoke` and records `result.metadata` on the call receipt (or throws on `{ kind: 'reject', reason }`).
    - Runtime pins the active Memory pointer at plugin-call entry so concurrent calls inside parallel `foreach` observe one consistent immutable version.

### 6.4 Event-Driven Boundary Trigger Dispatch, Cadence & Fault Isolation

- **Four serial boundaries** dispatched via `rsi/policy-boundary-completed` (`@mode serial`) from Policy executor ([executor.ts](../../../src/runtime/policy/executor.ts), [steps.ts](../../../src/runtime/policy/steps.ts)):
  - `iteration-completed` (matches `trigger.on: loop-iteration`, default): Fired at the end of each iteration of a top-level `loop` step; when `hasTopLevelLoop` is `false`, default triggers fall back to `policy-completed` (`experiment-end`).
  - `loop-completed` (matches `trigger.on: loop-end`): Fired once immediately after a top-level `loop` step completes.
  - `step-completed` (matches `trigger.on: after-step` + `trigger.step === stepId`): Fired immediately after each serial step completes.
  - `policy-completed` (matches `trigger.on: experiment-end`): Fired once after all top-level `steps` complete and before Policy output finalization.
- **`every: N` cadence & `--resume` idempotency**:
  - Persist independent boundary hit counters for Memory and Reflection in Policy checkpoints; execute only when `hitCount % every === 0` so `--resume` never duplicates or skips triggers.
- **Ordering & fault isolation**:
  - Register Memory's boundary listener before Reflection's so same-boundary matches always run **Memory first, then Reflection**, serially outside parallel `foreach` branches.
  - Ordinary execution, validation, or local-budget failures record a `failed` / `rejected` learning record without aborting the experiment; experiment cancellation, global budget exhaustion, and critical Runtime persistence failures still abort execution.

### 6.5 Shared Safe Write-Back Engine, CLI & Web Dashboard

- **Shared snapshot application core ([application.ts](../../../src/runtime/revisions/application.ts))**:
  - Extract snapshot planning, diff computation (`add` / `replace` / `remove`), active-experiment exclusion lock (`acquireResourceGate` + `blockingExperiments`), protected-root and symlink validation, and atomic temp-file + rename write-back into a shared service backing both `manager.reflection()` and a new `manager.memory()`.
  - **Memory destination resolution**: Default to recorded `sourceDirectory` when `directory` was configured; for zero-config experiments (`sourceDirectory: null`), accept an explicit destination via `--to <dir>` (CLI) or `targetDir` (Web API) under the exact same safety checks.
- **Symmetric CLI commands ([commands.ts](../../../src/entries/cli/commands.ts))**:
  - Keep `arsi reflection list [experiment-id]` / `show <revisionID>` / `apply <revisionID>`.
  - Add `arsi memory list [experiment-id]` / `show <versionID> [--to <dir>]` / `apply <versionID> [--to <dir>]`.
- **Web API & Dashboard ([learning.ts](../../../src/entries/web/learning.ts), [observation.ts](../../../src/runtime/services/observation.ts), `web/`)**:
  - Add symmetric routes:
    - `GET /api/observation/experiments/:id/memories/:ref/application?targetDir=...`
    - `POST /api/experiments/:id/memories/:ref/apply` (optional JSON body `{ targetDir?: string }`)
  - In Dashboard **Reflection & Memory → Memory**, add the same `Preview application` / `Apply to source files` confirmation workflow as Reflection (including a destination path input for zero-config experiments), and remove obsolete `type: reflection` step rendering from `web/features/experiments/policy-structure.tsx` and related helpers.

### 6.6 Built-in Plugins, Built-in Policies, Tests & Documentation

- **Built-in plugins & Doctor (`src/plugins/`, `src/runtime/doctor/`)**:
  - `memory.agent`: Ship built-in default `prompt.md` and `goal.md`; delete [comparison.ts](../../../src/plugins/memory-agent/comparison.ts); consume unified Runtime `evidence-views` snapshots.
  - `reflection.agent` & `proposer.agent` / `agent-editing`: Support default-open `x-rsi-path` targets in Reflection; remove `memoryRef` and `context/input.json`'s `memory` field from `proposer.agent` / `agent-editing` (relying on `rsi/before-agent-invoke` injection).
  - `doctor`: Validate new `memory` / `reflection` declarations, `memory.directory` paths, and synthesized built-in `agent.pi` readiness.
- **Built-in Policies & example Recipes (`src/policies/`, `examples/`)**:
  - Migrate `harness2`, `wikiskill`, `gym-rsi`, `parameter-agent`: remove `state.memoryRef` / `state.wikiRef`, `require.memoryUpdater`, `remember` / `save_memory` / `type: reflection` steps, and `memoryRef` from Policy output schemas; wire `defaults.{memory,reflection}` and minimal `memory.yaml` / `reflection.yaml` preserving view isolation and split exclusions (`harness2` keeps `evidence.view: execution`; `wikiskill` / `gym-rsi` use `trigger: { on: after-step, step: train }` and `excludeSteps: [validate, test, promotion]`).
  - `parameter-grid`, `parameter-optuna`: explicitly set `defaults: { memory: false, reflection: false }`.
  - `gepa`, `operator-search`: keep enabled by default without opt-out.
  - Migrate all example Recipes under `examples/`.
- **Verification & user documentation**:
  - Update and add `tests/unit/` coverage for new contracts, Cordis `waterfall` return-value chaining (`rsi/before-agent-invoke` and `rsi/before-call`), `rsi/memory-activated`, built-in `agent.pi` synthesis, 4-step `derivedCwd` injection under `agent-projects/<sha256>/project`, all 4 `rsi/policy-boundary-completed` triggers + `every` resume idempotency, `bindings` / `steps` evidence filters, `memory list/show/apply` (including `--to <dir>`), and Web routes.
  - Synchronize EN/ZH user guides (`docs/users/guides/memory*.md`, `reflection*.md`, `configuration*.md`, `writing-policies*.md`, `built-in-components*.md`, `doctor*.md`, `running-experiments*.md`, `runtime-events*.md`).
  - Acceptance gates for implementation: `pnpm check` (`format:check`, `typecheck`, `typecheck:web`, `test`, `build`) and `pnpm check:package`.
