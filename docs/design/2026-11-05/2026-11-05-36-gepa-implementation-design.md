# GEPA implementation through skill optimization: current design

Date: 2026-11-05

Status: Confirmed design, ready for implementation. The complete experiment is not implemented or verified.

Start here when continuing development on another machine. This document consolidates confirmed decisions 1–63. It supersedes the earlier [consolidated design](2026-11-05-20-gepa-consolidated-design-and-audit.md) as the implementation entrypoint and incorporates all subsequent decisions. Historical records remain unchanged; their pending proposals are resolved by the later decisions referenced below. This consolidation adds no requirements.

## Objective

Use an outer RSI experiment to optimize the general `ember-rsi` skill for writing Policies and adding plugins. Evaluate each skill candidate by asking a fresh development Agent to implement GEPA from the same fixed RSI repository baseline. Retain a human-accepted GEPA implementation together with the exact skill version that produced it.

The development task requires the GEPA paper's main algorithm in full. Automatic acceptance is deliberately small: run one minimal GEPA round on one fixed WorkBuddy task. This demonstrates the exercised integration, not full algorithm correctness, improved benchmark scores, or generalization of the skill. The user reviews implementation logic.

## Fixed scope and inputs

| Concern | Agreed scope |
| --- | --- |
| Skill edit target | `skills/ember-rsi/SKILL.md` and Markdown guidance under `skills/ember-rsi/references/` |
| Fixed skill support | Example code and configuration under `skills/ember-rsi/assets/` remain unchanged |
| Development task | GEPA Policy, necessary plugins, development self-tests, and run configuration |
| Algorithm reference | [GEPA paper v2](https://arxiv.org/abs/2507.19457v2) only; no official or other external GEPA implementations or implementation-derived explanations |
| Framework references | Fixed RSI source, candidate skill, and fixed RSI examples |
| Inner GEPA target | Only `plugins/office-base/prompts/office-discipline.md` in the existing Office AgentBundle; other Bundle files fixed |
| WorkBuddy task | `workbuddy/board-material-update-timeline-excel`, fixed across rounds after preflight |
| Delivery startup | Runnable Recipe and plugin-loading entry at paths fixed by the task package |

The development Agent decides the concrete Policy/plugin decomposition. The fixed task brief describes required behavior, allowed changes, references, and acceptance requirements without supplying an implementation blueprint. Its detailed paper-derived requirements still need preparation.

Keep RSI Runtime and CLI unchanged, including `src/runtime/builtins.ts`. The development Agent cannot modify the outer optimization infrastructure, formal acceptance scripts or passing criteria, or its supplied skill. Register extensions through the existing explicit plugin-loading mechanism. Missing framework capabilities must be reported rather than silently expanding scope.

## Components and reuse

| Component | Responsibility |
| --- | --- |
| Existing Runtime/Manager | Candidate and measurement facts, receipts, budgets, calls, cancellation, and instance lifecycles |
| Outer Policy | Coordinate development evaluation, proposals, human review, rounds, and completion |
| AgentBundle Application | Own skill candidates, enforce existing edit constraints, and manage instances |
| New development Evaluator plugin | Prepare the task, invoke existing Evaluator/DSH execution, retain delivery and evidence, run independent acceptance, and report development cost and quality |
| Existing ember-evaluator | Local Harbor task loading, DSH AgentBundle execution, environments, artifact collection, traces, persisted results, and available usage accounting |
| New skill Proposer plugin | Reuse existing file-reading/editing/commit capabilities; assemble approved feedback, choose a historical skill base, and update authorized documentation |
| New human-review plugin | Present reports and receive validated decisions through its own standalone feedback command |

Use a local Harbor task package for development. Prepare the fixed checkout, paper, original requirements, development environment, and declared delivery paths in advance. Supply the current skill through the development AgentBundle, not a stale copy embedded in the task package.

At each Agent startup, supply the current candidate's `SKILL.md` content. Make its reference documents and the fixed assets available on demand. Expose one authoritative skill version and record what was supplied. Loading instructions does not establish that the Agent followed them; real integration must verify delivery and observed use.

Before development, prepare required materials and dependencies. During development, allow only the configured model endpoint; ordinary web access and dependency downloads are unavailable. Preparation and independent WorkBuddy acceptance have separate network requirements. Prepared materials must also obey the paper-only GEPA restriction.

Development self-tests cover locally runnable builds, type checks, unit tests, plugin/configuration loading, and controlled simulations. Do not run real WorkBuddy from inside the first-version development task. Real WorkBuddy execution belongs to preflight and independent acceptance.

## Outer loop

1. Preflight the selected WorkBuddy task using the existing Bundle and configured task model before real development starts. Freeze the experiment's repository, skill baseline, task material, and role parameters.
2. Start a development attempt with the chosen skill, fixed baseline, fresh DSH session, fixed task brief, and that attempt's acceptance items. Do not reuse prior generated code or conversations.
3. Let the Agent design, code, self-test, and repair within the development limit. Retain available source, traces, and usage before releasing its workspace.
4. After delivery, the Evaluator launches its fixed acceptance runner in a new process using the delivered Recipe and plugin entry. Use independent run outputs, not self-test state.
5. Check this acceptance run's framework records: the selected WorkBuddy task must actually execute and produce an evaluation result, and the minimal GEPA round must finish normally. A success message or clean process exit alone is insufficient. No score threshold or improvement requirement is imposed.
6. Route established development issues to the Proposer. On automatic acceptance success, request human logic review. Confirmed environmental faults stop automatic optimization; after repair, retry the same skill with a fresh checkout/session. Uncertain causes require human judgment before another attempt or skill revision.
7. The Proposer uses the recorded evidence to choose a current or historical base, explains that choice, and edits only permitted skill documentation. The next attempt starts from the same repository baseline. A `no-change` result requests human input rather than repeating unchanged development automatically.
8. Human acceptance ends successfully with the reviewed implementation/skill pair. Stopping, exhausting limits, or timing out retains available results without declaring acceptance.

Count a development round when development starts, including failed or timed-out attempts. Simulation, preflight, proposal work, and human waiting do not themselves consume development rounds. Selecting an old skill or retrying after environmental repair does not reset counters or budgets. Further attempts beyond the configured limit need a new explicit user decision.

First-run success means the first formal acceptance after delivery. Development self-tests do not count as formal acceptance. Preserve that first result independently of later success. One WorkBuddy task limits dataset size; a GEPA round can evaluate that task multiple times.

## Configuration and cost

| Setting | Initial value | Scope |
| --- | --- | --- |
| `maxRounds` | 10, configurable | Includes the original skill attempt |
| Development limit | 60 minutes, configurable | Coding, self-tests, and repair for one attempt |
| Independent acceptance limit | 4 hours, configurable | One formal acceptance execution; starts when its runner launches |
| Review waiting limit | 24 hours, configurable | Each wait once review material is available |
| Overall `budget.elapsedWallMs` | 259200000, configurable | 72 hours including proposals, acceptance, and human waiting |
| Development Agent model | `ds-v4.1-flash` | DSH development |
| Outer Proposer model | `ds-v4.1-flash` | Skill proposals |
| WorkBuddy task Agent model | `ds-v4.1-flash` | Preflight and formal acceptance |
| Inner GEPA proposal model | `ds-v4.1-flash` | Office prompt proposals |

Keep each role's model and execution parameters fixed across rounds. The remaining overall budget bounds every stage; stage transitions do not reset the experiment clock. Timeout must stop owned execution, preserve available evidence, and follow normal cancellation/cleanup. Timeout alone does not establish whether a failure is a development or environmental problem.

Return only development-Agent coding, self-testing, and repair cost to the outer Proposer. Tokens are the primary cost indicator; model-call count and development duration are supplementary. Exclude independent acceptance, preflight, proposal work, report preparation, and human waiting. Overall usage reporting is best effort through existing interfaces; missing amounts remain unknown, not zero. Prefer quality first and lower development token usage among versions with comparable observed quality.

## Human feedback

The Evaluator returns before waiting. The Policy invokes the human-review plugin, which writes a unique request under `.rsi/`, displays a terminal summary, saves a local report, and waits while the RSI process remains alive. Its standalone command submits feedback for that request; a plugin-owned `show` action displays saved material. Neither command extends the RSI CLI.

| Review context | Response | Outcome |
| --- | --- | --- |
| Implementation review | Continue with issues | Send feedback to the Proposer and update subsequent acceptance items |
| Implementation review | Accept | End successfully with the reviewed pair, after automatic acceptance |
| Failure diagnosis | Development problem, with explanation | Send the diagnosis and evidence to the Proposer |
| Failure diagnosis | Environment repaired; retry | Start a fresh attempt using the same skill and fixed baseline |
| Either context | Stop | Retain results and end unfinished |

Identifying an environmental problem without confirming repair does not trigger a retry. Continue waiting within the existing deadlines. Bind responses to the active request and attempt. Silence is not approval. A review timeout ends unfinished; an earlier overall timeout follows existing Runtime cancellation. The first version does not promise recovery after the RSI process exits.

Reports include execution/acceptance results, development cost, outstanding issues, and a concise Evaluator-authored explanation of added Policies/plugins and categorized changed files. Provide navigation to retained files, not a mandatory detailed source-diff analysis. Do not require the development Agent to produce an implementation index.

Also show a brief explanation of skill changes and why they were made, linking to the skill actually used for the reviewed attempt. For uncertain failures, identify the failed stage, relevant evidence, and remaining uncertainty.

Human-reported implementation issues always concern unmet original requirements, not new requirements. The Evaluator maintains automated checks where practical and a manual algorithm-review checklist otherwise. Prepare these items before each attempt and keep their version fixed during that attempt. Neither the Proposer nor the development Agent changes formal acceptance criteria.

## Proposal evidence and constraints

Give the Proposer concise summaries of all available rounds, including skill version, execution/acceptance outcome, human issues, and development cost. Let it read relevant detailed traces on demand and preserve missing/truncated-evidence markers. Do not insert all raw history into every prompt or carry this development history into the next development Agent session.

Adapt Harness² INV reasoning: observe actual behavior, identify an improvement hypothesis, make a small reusable documentation change, state the expected behavior, and check it in a later attempt. Related edits may span permitted documents. Include the approved cost/quality/human feedback; do not copy the original INV verifier-blind evidence restriction. Keep guidance general to RSI Policy/plugin development rather than encoding the GEPA solution.

Do not add the proposed extra skill-validation gate, local-document-link check, or one-shot correction/escalation branch. After a successful normal candidate commit, proceed to development evaluation. Existing editing and Application commit constraints remain in effect.

## Result delivery

After formal acceptance and human approval, export a separate result package under the experiment's `.rsi/` area containing the reviewed GEPA source/run configuration, the exact skill version that produced it with its fixed support material, and a short summary with evidence navigation.

Do not automatically overwrite the working repository or installed everyday skill. Applying the accepted package is a later explicit action. Preserve historical and unfinished attempts without labeling them accepted.

## Implementation guidance and verification boundaries

Use the existing extension loader (`index.mjs` exporting `register(registry)`, supplied through `--plugin-dir` or the corresponding programmatic option). Reuse public artifact, candidate, measurement, and workspace services. Do not edit Manager facts, receipts, or checkpoints to force continuation.

The existing Agentbench Evaluator throws on relevant nonzero SDK results. The new business adapter must classify expected development failures as feedback before crossing that fatal call boundary. Catching a failed nested Runtime call later does not undo Manager cancellation. Preserve infrastructure, cancellation, and unknown-execution semantics.

The existing Proposer edits its supplied `input.parent`; the skill-specific plugin must explicitly select and commit against the actual historical base. Assemble approved feedback through public interfaces. Existing execution-only evidence projection does not automatically include all cost/quality/human fields.

Keep the business outcome explicit in saved reports and Policy output. A normally returning Policy may have Runtime status `succeeded` even when the business outcome is unfinished; do not invent a Runtime status or equate it with human acceptance.

Implementation order is already agreed: exercise the real outer Policy, registration, Application/Proposer integration, and review handling with controlled external results first; then connect real DSH and WorkBuddy; then run preflight before optimization. Cover continuation, acceptance, stopping, no-change, failure diagnosis, limits/cancellation, stale or repeated feedback, and retained artifacts within the simulation's relevant boundaries.

Before real execution, prepare the paper-derived task brief, frozen baseline and skill snapshots, local task package, development Bundle/materials, explicit delivery paths, and the narrow Office prompt Target. Existing Harness² Target configuration also permits a skill directory and cannot be used unchanged. Model endpoints, credentials, actual skill delivery, isolated development, export, and formal acceptance still require real verification.

## Evidence available at handoff

The most recent inspected RSI source is `838e679e57fb0617655ac1528c778f8a8b672643`. This identifies the source inspected, not an already frozen experiment baseline. The local Evaluator inspected was `034a7da3acd7c6311d4a7dfb5c037e523a172fbd`; RSI currently locks the SDK to `a585889ecbf6e33fc3900507e72712bade5201df`.

The [SDK reuse investigation](2026-11-05-21-gepa-evaluator-reuse.md) resolved the earlier inability to inspect Evaluator. Selected execution/accounting interfaces matched between those SDK revisions; other files differed, so full equivalence is not established. Use the repository's pinned dependency unless a concrete change requires an explicit dependency update.

That investigation added two controlled test files in a separate Evaluator checkout: `tests/fixtures/repository-development/plugin.mjs` and `tests/integration/repository-development.test.ts`. It recorded 59 passing selected tests, type checking, and the normal install/build lifecycle. The new cases exercised code export, persisted known/unknown usage and failure evidence, cleanup, and a fresh-process check of exported fixture code.

Those test additions are local to the separate Evaluator checkout and are not included in this RSI documentation branch. The historical result is evidence of an SDK component simulation, not a reproducible test addition supplied here or a complete outer-loop test. Production plugins, the full outer loop, real DSH development, WorkBuddy preflight, and GEPA acceptance remain unimplemented/unverified. This documentation handoff adds no new runtime verification.

## Decision sources

The [previous consolidation](2026-11-05-20-gepa-consolidated-design-and-audit.md) links decisions 1–49. The following records resolve the subsequent choices; later confirmed decisions take precedence over earlier pending proposals.

| Decisions | Record |
| --- | --- |
| 50 | [SDK reuse investigation](2026-11-05-21-gepa-evaluator-reuse.md), [explicit confirmation](2026-11-05-22-gepa-evaluator-reuse-confirmation.md) |
| 51 | [Local task package](2026-11-05-23-gepa-local-development-task.md) |
| 52 | [Development Evaluator plugin](2026-11-05-24-gepa-development-evaluator-plugin.md) |
| 53–54 | [Uncertain failures](2026-11-05-25-gepa-uncertain-failure-review.md), [diagnostic feedback actions](2026-11-05-26-gepa-failure-review-actions.md) |
| 55–56 | [Development network](2026-11-05-27-gepa-development-network.md), [skill loading](2026-11-05-28-gepa-skill-loading.md) |
| 57–58 | [Fixed startup](2026-11-05-29-gepa-fixed-acceptance-entry.md), [minimal-run evidence](2026-11-05-30-gepa-minimal-run-evidence.md) |
| 59–60 | [Local self-tests](2026-11-05-31-gepa-development-self-tests.md), [acceptance timeout](2026-11-05-32-gepa-acceptance-timeout.md) |
| 61–63 | [Result export](2026-11-05-33-gepa-result-package.md), [skill Proposer](2026-11-05-34-gepa-skill-proposer-plugin.md), [no extra skill check](2026-11-05-35-gepa-no-extra-skill-check.md) |
