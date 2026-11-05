# GEPA skill optimization: consolidated design and interface audit

Date: 2026-11-05

Status: Confirmed requirements consolidated; implementation recommendations remain proposals. Static interface inspection only.

This document consolidates decisions 1–49 without changing their agreed scope. It is the current reading entrypoint; the earlier records remain historical evidence. The user authorized consolidation and an interface audit, not execution of the experiment in this step.

Source inspection used repository revision `b2c7da2ba39b2f1e7f6c921ec8aa470354370a38`. Findings below describe that revision, rather than assuming older inspection notes still describe the current code.

## Objective and the two optimization tasks

The outer RSI experiment improves the general ember-rsi skill for writing Policies and adding plugins. Each skill candidate is tested by asking a fresh development Agent to implement GEPA from the same fixed RSI repository baseline. Retain a human-accepted GEPA implementation with the exact skill version that produced it.

The generated GEPA implementation has a separate, small acceptance task: optimize the existing Office prompt in a DSH AgentBundle using one WorkBuddy task. This acceptance workload checks integration and basic execution. It does not establish full algorithm correctness, optimization gains, or general skill improvement.

| Concern | Agreed scope |
| --- | --- |
| Outer optimization target | `skills/ember-rsi/SKILL.md` and Markdown guidance under `skills/ember-rsi/references/` |
| Fixed skill support material | Example code, configuration, and other assets under `skills/ember-rsi/assets/` |
| Development task | Implement the GEPA paper's main algorithm as an RSI Policy and necessary plugins |
| Algorithm reference | The fixed [GEPA paper v2](https://arxiv.org/abs/2507.19457v2); no external GEPA implementations or implementation-derived explanations |
| GEPA acceptance target | `plugins/office-base/prompts/office-discipline.md` in the existing Office Bundle; all other Bundle files fixed |
| Acceptance task ID | `workbuddy/board-material-update-timeline-excel` |
| Automatic acceptance | One minimal GEPA round on that one task, started in a new process from delivered code and configuration |
| Logic acceptance | Human review, including accumulated issues concerning the original requirements |

The development Agent designs the concrete Policy/plugin decomposition using the current skill. A fixed task brief must describe required behavior and boundaries without supplying an implementation blueprint. That brief, its paper-derived algorithm requirements, and the concrete repository baseline still need preparation. The audit did not inspect an official GEPA implementation or validate the algorithm against the paper body.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| Runtime Manager | Existing candidate/measurement facts, receipts, budgets, controlled calls, and instance lifecycles |
| Outer Policy | Coordinate evaluation, proposal, human review, round counting, and completion decisions |
| Outer Application | Own the skill candidates and their allowed edit boundaries; provide instances through the selected application path |
| Development Evaluator | Invoke DSH development, retain its delivery and evidence, perform independent acceptance, report development cost and quality, prepare review material, and maintain feedback-derived acceptance items |
| Development Agent | Design, code, self-test, and repair GEPA within the allowed repository scope |
| Skill Proposer | Diagnose recorded development behavior and feedback, select a current or historical skill base, and edit only authorized skill documentation |
| Human-review plugin | Present review material, wait for a response, validate it against the review request, and return the decision to the Policy |
| User | Review algorithm logic, supply issues, accept the paired implementation/skill result, or stop unfinished |

The Evaluator finishes its development/acceptance work before the Policy invokes human review. It does not own the loop or wait internally for review feedback. Its implementation explanation may inspect source files, but detailed source-diff analysis is not an evaluation requirement. A development-Agent-authored implementation index is not required.

Runtime and RSI CLI source remain unchanged. This also excludes adding registrations by editing `src/runtime/builtins.ts`; extensions must use the existing explicit plugin-loading mechanism. The experiment infrastructure is prepared outside the GEPA development attempts. The development Agent cannot edit that infrastructure, the skill candidate, or formal acceptance criteria.

## Agreed flow

1. Implement and validate the orchestration with simulated development and acceptance results. Exercise actual Policy and review handling with controlled external results.
2. Connect the real DSH development path and WorkBuddy evaluation. Preflight the selected WorkBuddy task with the existing Bundle and selected task model before development begins.
3. Start an attempt from the frozen repository baseline and a fresh Agent session, with the selected skill, fixed task brief, paper, and that attempt's acceptance requirements. Do not reuse previous generated code or development conversations.
4. Let the Agent code, self-test, and repair within the development limit. Once it delivers, retain the available code, trace, and usage, then run formal acceptance in a new process with independent run outputs.
5. Send development problems to the Proposer. On automatic acceptance success, request human review. Confirmed environment faults stop automatic skill optimization; after repair, retry the same skill with the same fixed baseline and a fresh session under the existing limits and recovery constraints.
6. Apply the review decision. Continue feedback updates the recurring acceptance items and informs the next skill proposal. Accept ends successfully. Stop retains results and ends unfinished.
7. A Proposer `no-change` result requests human input, even if automatic acceptance has not passed. It does not cause repeated same-input development. Round exhaustion, review timeout, and total-time exhaustion cannot silently authorize further development or successful completion.

Count a development round when development starts, including attempts that fail or time out. Simulation and preflight do not count as development rounds. At the round limit, preserve results and report the outcome; any additional attempts follow a new explicit user decision and the existing execution/configuration rules.

The first formal acceptance result is recorded separately from any later success. Development self-tests are allowed, but do not substitute for that first formal run. One task can require multiple model calls or task executions within the minimal GEPA round.

## Configuration and accounting

| Setting | Selected value | Meaning |
| --- | --- | --- |
| `maxRounds` | 10 | Includes the original skill attempt; configurable |
| Development timeout | 60 minutes | Coding, self-tests, and repairs for one attempt; configurable |
| Human review waiting limit | 24 hours | Per review wait, bounded by remaining overall time; configurable |
| `budget.elapsedWallMs` | 259200000 | 72 hours overall, including proposals, independent acceptance, and human waiting; configurable |
| Development Agent model | `ds-v4.1-flash` | DSH development invoked by the Evaluator |
| Outer Proposer model | `ds-v4.1-flash` | Skill proposal work |
| WorkBuddy task Agent model | `ds-v4.1-flash` | Preflight and GEPA acceptance task execution |
| GEPA prompt-proposal model | `ds-v4.1-flash` | Office prompt proposals during GEPA acceptance |

Keep each role's model and execution parameters fixed across rounds. Endpoints, credentials, parameter compatibility, and usage availability have not been verified. Stage-specific configuration field names other than the already selected `maxRounds` and existing Runtime budget field remain implementation details.

The cost supplied to the outer Proposer includes only development-Agent coding, self-tests, and repairs. Token usage is primary; model-call count and development duration are supplementary. An Agent self-test remains development work even when it calls the same WorkBuddy services used by independent acceptance. Classify cost by execution stage, not merely by model name.

Exclude independent acceptance, preflight, proposal work, report preparation, and human waiting from that feedback cost. Overall usage reporting is best effort through existing interfaces. Missing values remain unknown, never zero. Prefer quality first; among versions of comparable observed quality, prefer lower development token usage.

## Human feedback and proposal evidence

The review plugin owns request/response files under `.rsi/`, with a unique request identifier tied to the attempt and implementation. Its standalone feedback command does not extend the main RSI CLI. Present a terminal summary, a saved report, and a plugin-owned way to show the report.

The three human decisions are continue optimization with issues, accept, and stop unfinished. A review timeout is a separate execution outcome, not implied acceptance. The RSI process stays alive while waiting; process-exit recovery is not promised.

The report includes formal execution results, development cost, a concise Evaluator-authored explanation of the implementation, outstanding review items, and a brief skill-change explanation with file links. Link to the skill actually used in the reviewed attempt and identify its selected base, rather than showing an untested later proposal.

All human-reported implementation issues concern unmet original requirements. The Evaluator maintains automatic checks where appropriate and a human checklist for algorithm judgments. Prepare the applicable requirements before the next attempt and keep them fixed during that attempt. The Proposer does not edit acceptance criteria.

Preserve each skill version and associated results. Supply the Proposer with per-round summaries and read access to relevant development traces. It inspects relevant tool calls, results, errors, and self-tests before editing. Historical skill versions may be selected as a new proposal base, with a reason; this does not reuse their generated code or reset round accounting.

Adapt the Harness² INV method: observation, improvement hypothesis, smallest useful change, expected behavioral difference, and a later check. Retain the agreed cost, preliminary acceptance, and human feedback; do not copy INV's verifier-blind restriction unchanged. Keep lessons general to Policy/plugin development and do not encode the GEPA answer into the skill.

## Current interface audit

These findings are static source observations. An available interface is not evidence of successful integration or execution.

| Area | Current evidence | Consequence for this design |
| --- | --- | --- |
| Policy orchestration | [Step execution](../../../src/runtime/policy/steps.ts) supports awaited invocation, state, conditionals, bounded loops, and control. [Policy execution](../../../src/runtime/policy/policy.ts) journals settled step results. | Reuse the DSL for the loop and review wait. A new Runtime pause instruction is unnecessary. Current invoke syntax uses `use` and `with`; do not rely on older syntax notes. |
| Plugin loading | [Registry](../../../src/runtime/registry/index.ts) registers an operation with its contract and registers Policy paths. [Loader](../../../src/runtime/loaders/plugins.ts) loads `index.mjs` exporting `register(registry)`; [CLI options](../../../src/entries/cli/commands.ts) already expose `--plugin-dir`. | Package the experiment extension and standalone feedback entrypoint through this path. No Runtime builtin-list or CLI dispatcher edit is needed. |
| Candidate storage and edit scope | [AgentBundle Application](../../../src/plugins/application-agentbundle/service.ts) uses [file-application lifecycle](../../../src/plugins/shared/file-application/files.ts), which checks Target constraints, records candidate parentage, materializes instances, and releases workspaces. | Reuse candidate sealing and allowed-path checks. A bare skill folder is not automatically a valid AgentBundle: a fixed development Bundle and its skill-loading arrangement still need assembly and verification. |
| Existing evaluation contract | [Agentbench contract](../../../src/contracts/plugin-types/agentbench.ts) accepts only a candidate and task IDs and returns a measurement reference. [Evaluator service](../../../src/plugins/evaluator-agentbench/service.ts) runs the SDK and normalizes its results. | This is a benchmark execution integration, not a complete repository-development evaluation interface. Workload inputs, code delivery, acceptance revision, development-only usage, and review material need business-layer adaptation. |
| Failure behavior | The current Evaluator throws on runner failure and relevant nonzero exit conditions. [Call supervision](../../../src/runtime/manager/calls.ts) reports ordinary call failures to the [Manager](../../../src/runtime/manager/index.ts), which aborts the experiment. | Expected development/acceptance failures need classified result data before crossing a fatal Runtime call boundary. Catching an already-failed nested `context.invoke` is insufficient to undo Manager cancellation. Real infrastructure cancellation or unknown execution must not be disguised as a successful evaluation. |
| SDK runner | The shared [runner](../../../src/plugins/shared/evaluator-adapter/sdk.ts) calls `parseUserConfig` and `Evaluator.run`; [configuration](../../../src/plugins/evaluator-agentbench/configuration.ts) supplies the AgentBundle directory to the SDK solver. | Reuse this path where supported. It does not itself prove custom repository-task setup, code export, nested test capabilities, or development token collection. |
| Measurement and artifacts | [Public services](../../../src/contracts/runtime/services.ts) expose artifact capture/materialization, measurement recording and reading, charging, and instance acquisition. The [Measurement schema](../../../src/contracts/models/measurement.ts) has unavailable metrics, typed extensions, and evidence references. | Preserve outcomes through these interfaces and plugin-owned artifacts. Capture development delivery before releasing its workspace. Do not directly rewrite Manager facts or receipts. |
| Usage coverage | The [SDK provenance adapter](../../../src/plugins/shared/evaluator-adapter/measurement.ts) records `usageKnown: false`. [Pi execution](../../../src/plugins/agent-pi/service.ts) charges model calls; this is not an automatic ledger of external DSH development tokens. | Cost normalization requires backend evidence. A working `charge` interface cannot establish usage that was never collected. |
| Proposer base selection | [Proposer implementation](../../../src/plugins/proposer-agent/service.ts) edits `input.parent`. The [contract](../../../src/contracts/plugin-types/proposer.ts) allows read-only source candidates but does not ask the model to choose the committed parent. | Reuse editing and Application commit mechanics, but add explicit historical-base selection and record the real selected parent. The existing plugin cannot be assumed to implement decision 37 unchanged. |
| Proposer feedback | [Execution projection](../../../src/runtime/services/facts/evidence-files.ts) provides execution files, not scoring views. [Proposer projection](../../../src/plugins/proposer-agent/execution-context.ts) uses those files and truncates tool-return previews. | Compose approved cost/quality/human summaries with authorized execution evidence in the business plugin. A prompt change alone does not make omitted metrics or review feedback available. Preserve missing/truncated-evidence markers. |
| Proposer tools | [Shared editing helpers](../../../src/plugins/shared/agent-editing/index.ts) can assemble read-only context and commit bounded edits; Pi supplies virtual-file reads rather than host shell access. | Reuse Pi for skill reasoning/editing. DSH remains the selected backend for actual repository development. Do not reinterpret the Pi Agent as an existing coding-shell backend. |
| Review and recovery | Ordinary operations can await under `context.signal`. [Operation](../../../src/contracts/operation.ts) also now has limited `canRetry` support for reconciled failed calls; running, cancelled, or unknown outcomes are not blindly retried. | Build bounded review file exchange in the plugin. Limited retry support does not establish durable human-review suspension or process restart recovery. |
| Terminal outcome | Manager records a normally returning Policy as Runtime `succeeded`, while thrown failures/cancellation use their existing statuses. | Keep the business outcome, such as accepted versus unfinished, explicit in Policy output and the saved report. Do not add or forge a Runtime status. An expired overall budget may terminate before a normal Policy output, so retain progress before waiting and preserve the actual cancellation facts. |

The existing [Office target](../../../examples/harness/dsh-harness2/target.yaml) also permits editing a skill directory. Acceptance needs a narrower Target containing only the Office prompt; reusing that target unchanged would violate decision 44. Static inspection of the [Office Bundle plugin](../../../examples/harness/dsh-harness2/baseline/plugins/office-base/index.js) confirms its prompt-reading code, not successful runtime use of the edited prompt.

### SDK inspection limit

The [lockfile](../../../pnpm-lock.yaml) resolves `ember-evaluator` to commit `a585889ecbf6e33fc3900507e72712bade5201df`. The installed dependency's `package.json` was not present at the expected local path during this audit. Read-only GitHub connector requests for that commit's package file and tree both returned HTTP 404. This does not prove that the repository or capability is absent; it means the pinned SDK implementation was not inspectable through those paths in this session.

Consequently, custom development-task packaging, an isolated writable checkout, code export, usable development traces, cancellation, and stage-specific token capture remain unverified SDK/DSH integration requirements. WorkBuddy preflight alone would not prove those repository-development capabilities. Verify them in the real-integration stage after the simulated loop is established, without silently changing the selected backend or Runtime constraint.

## Recommended plugin assembly, pending discussion

The confirmed responsibilities appear implementable around the public Runtime boundaries, but end-to-end feasibility remains conditional on the DSH/SDK development workload. The following is the audit's recommended assembly, not an additional confirmed design decision:

1. Add a dedicated repository-development Evaluator plugin with an appropriate public contract. Reuse the existing AgentBundle/SDK integration where supported. It should distinguish a completed evaluation whose developed code failed acceptance from an infrastructure failure or unknown execution, retain the relevant artifacts, and return the agreed cost/quality feedback. Ordinary code defects then reach the Policy and Proposer without aborting the outer Runtime.
2. Add the already agreed human-review plugin and its own command, with validated request/response files, three human decisions, and bounded waiting. Repeated submissions, stale request IDs, cancellation, and result retention need behavior tests during the simulation stage.
3. Adapt or add a skill-focused Proposer using the existing editing helpers and Application lifecycle. It must assemble the approved summaries and traces, select an authorized historical base, and enforce documentation-only changes. This adaptation belongs in business plugins, not Runtime evidence projection.
4. Register the extension's operations/contracts and outer Policy through `--plugin-dir`. The generated GEPA implementation must use the same existing registration facilities rather than altering Runtime or CLI source.

The first discussion after this audit should settle item 1: the dedicated development Evaluator and its failure-as-feedback boundary. SDK workload details and the exact plugin contracts can then be resolved from the available interfaces. Plugin names and wire-field names above are not finalized.

## Validation order and remaining work

Simulation must use real Policy/registration/review components while replacing external development and evaluation results with deterministic fixtures. Cover the relevant continue/accept/stop/no-change paths, round limits, timeout/cancellation, and artifact retention. This establishes orchestration only.

Real integration must then establish that the selected skill is actually supplied to a fresh DSH session, the fixed checkout can be developed and exported, available usage belongs to the development stage, and delivered code can be launched in a separate acceptance process. Run the chosen WorkBuddy preflight before real optimization rounds. Do not report a simulated success or a readable configuration as a successful GEPA experiment.

Before execution, prepare the fixed repository and skill snapshots, the paper-only task brief, the narrow Office acceptance Target, and concrete extension packaging. The mechanism for producing and maintaining acceptance items must preserve their per-attempt version; future human feedback must not mutate a historical result. Exact cleanup/retry behavior for the custom development workload remains subject to the inspected SDK and existing Runtime recovery rules.

## Decision sources and supersession

The latest confirmed decision governs when earlier records differ:

- Decisions 15 and 36 replace the earlier requirement for source comparison or a separate implementation index. Evaluator-authored, concise review explanation remains required.
- Decision 43 assigns feedback-derived acceptance maintenance to the Evaluator, within the outer-loop ownership established by decision 6.
- Decisions 32–34, 40, and 44–48 specialize the initially unspecified acceptance task, environment checks, models, and limits.
- Decisions 37–39 and 49 specialize historical selection, evidence access, comparison priorities, and skill-change presentation.
- Current source findings above supersede older static observations where the code has changed; they do not rewrite historical documents or alter approved requirements.

| Decisions | Record |
| --- | --- |
| 1–13 | [Initial design](../2026-11-04/2026-11-04-gepa-skill-optimization.md) |
| 14–31 | [Context, scope, costs, and proposal method](2026-11-05-gepa-skill-optimization.md) |
| 32 | [WorkBuddy acceptance scope](2026-11-05-02-gepa-workbuddy-acceptance.md) |
| 33 | [Fixed task across rounds](2026-11-05-03-gepa-fixed-acceptance-task.md) |
| 34 | [Environment preflight](2026-11-05-04-gepa-environment-preflight.md) |
| 35 | [Feedback against original requirements](2026-11-05-05-gepa-review-feedback-scope.md) |
| 36 | [Evaluator review summary](2026-11-05-06-gepa-evaluator-review-summary.md) |
| 37 | [Historical proposal bases](2026-11-05-07-gepa-historical-skill-bases.md) |
| 38 | [Quality-first comparison](2026-11-05-08-gepa-quality-first-selection.md) |
| 39 | [Summary-first evidence access](2026-11-05-09-gepa-proposer-history-access.md) |
| 40 | [Fresh-process acceptance](2026-11-05-10-gepa-fresh-process-acceptance.md) |
| 41 | [Three human decisions](2026-11-05-11-gepa-human-review-decisions.md) |
| 42 | [Review waiting limit](2026-11-05-12-gepa-review-wait-timeout.md) |
| 43 | [Acceptance-item ownership](2026-11-05-13-gepa-evaluator-acceptance-items.md) |
| 44 | [Office prompt target](2026-11-05-14-gepa-office-prompt-acceptance-target.md) |
| 45 | [Acceptance models](2026-11-05-15-gepa-acceptance-models.md) |
| 46 | [Simulation before real integration](2026-11-05-16-gepa-staged-integration.md) |
| 47 | [Selected WorkBuddy task](2026-11-05-17-gepa-selected-workbuddy-task.md) |
| 48 | [Overall time limit](2026-11-05-18-gepa-overall-time-limit.md) |
| 49 | [Skill-change review summary](2026-11-05-19-gepa-skill-review-summary.md) |

## Actual verification in this step

Read the existing 49 decision records and the relevant current contracts, plugin implementations, Policy execution, Registry/loading, Manager call/budget handling, evidence projection, and WorkBuddy example configuration. Checked this document's UTF-8/LF formatting, final newline, local links, and decision-source coverage.

No source code, dependencies, Runtime, CLI, or experiment configuration was changed. No tests, simulated workflow, model request, DSH development session, preflight, or WorkBuddy run was executed. The SDK read limitation above remains unresolved. There is no new evidence of GEPA correctness, a successful experiment, or skill improvement.
