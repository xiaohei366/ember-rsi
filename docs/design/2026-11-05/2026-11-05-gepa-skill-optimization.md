# GEPA skill experiment context isolation and evaluation scope

Date: 2026-11-05

Status: Design discussion in progress. Only confirmed decisions are recorded below.

This continues the [2026-11-04 design discussion](../2026-11-04/2026-11-04-gepa-skill-optimization.md). Decision 14 extends the fixed-start requirement from decision 1. Decision 15 supersedes the Evaluator's source-comparison responsibility in decision 7 and the related assumption in decision 13 that evaluation evidence supplies source diffs. Other confirmed decisions remain in effect.

## Confirmed decision 14: Reset the development Agent context for every attempt

Start each development attempt in a fresh Agent session, without inheriting previous development conversations or generated implementation code. Supply the fixed repository baseline, task instructions, the acceptance requirements for that attempt, and the candidate skill being evaluated.

The Proposer retains access to accumulated problems and human feedback to improve the skill. Improvements reach the next development attempt through the revised skill; previous development sessions are not resumed or reused as additional context.

## Confirmed decision 15: Limit Evaluator feedback to cost and quality

The Evaluator invokes the development task, runs the independent acceptance checks, and reports cost and implementation quality feedback. It does not compare source code or produce source-diff analysis as part of its evaluation output.

Retain the generated implementation for human review. The concise navigation index from decision 13 still identifies Policies, plugins, and categorized added or modified files. This is review navigation rather than an Evaluator quality assessment; its production must be separate from the removed source-comparison responsibility. Full diffs are no longer required as Evaluator output.

Decision 16 defines the initial quality criterion. Any scoring formula remains undecided. Measured costs must remain distinguishable from unavailable usage information. Human logic review and the user's completion decision remain required after automatic acceptance passes.

## Confirmed decision 16: Initially verify only that the experiment can run

The Evaluator's initial quality criterion is whether the generated experiment can run. Use a bounded preliminary execution check; do not require a detailed experiment, a full GEPA optimization campaign, or benchmark evidence of optimization gains for this initial evaluation.

Quality feedback reports the observed execution result and any failure that prevents the experiment from running. Cost feedback remains part of the evaluation. The user separately reviews whether the implementation logic follows the intended design.

A successful preliminary run establishes only the behavior exercised by that check, not full algorithm correctness or optimization effectiveness. Decision 17 defines the execution stopping point; exact check inputs remain to be specified. Configuration validation alone must not be reported as successful execution.

## Confirmed decision 17: Run one minimal round for preliminary acceptance

Use a minimal task and dataset to execute one round of the generated experiment and confirm that it finishes normally. This is the initial automatic acceptance boundary. It exercises plugin registration, operation calls, and basic flow integration while keeping execution cost bounded.

Apply the first-formal-acceptance accounting from decision 4 to this check. Passing one minimal round does not establish correctness of unexercised branches, multi-round behavior, or optimization effectiveness; human logic review remains required.

## Confirmed decision 18: Feed back only development Agent cost to the Proposer

The cost feedback from the Evaluator to the Proposer covers only the development Agent's work to write code, run its own tests, and repair errors. The Agent's self-tests are included; the Evaluator's separate preliminary acceptance run is excluded.

Exclude Proposer activity, independent evaluation work, report generation, and human waiting from this feedback cost. A broader experiment total may be shown to the user, but must be labeled separately and must not replace the development-only cost supplied to the Proposer. The proposed inclusion of independent acceptance cost in this feedback was not adopted.

The Runtime Manager remains the owner of experiment-wide accounting and budgets. Plugins and execution adapters report observed usage through the existing accounting interface. Capturing the development Agent's usage and selecting it for evaluation feedback are integration responsibilities; a central ledger alone does not make unreported external usage observable. No Runtime or RSI CLI changes are authorized by this accounting decision.

## Confirmed decision 19: Report total usage on a best-effort basis

Complete experiment-wide cost reporting is not a primary requirement for this first version. Capture and report available usage through existing Runtime interfaces without modifying the Runtime. Preserve missing or unknown usage explicitly rather than presenting incomplete totals as complete or interpreting missing values as zero.

This best-effort scope applies to the optional overall usage display. It does not widen the development-only feedback cost defined in decision 18: the Evaluator still supplies the Proposer with only the development Agent's coding, self-testing, and repair cost.

## Confirmed decision 20: Prefer DSH through the existing AgentBundle execution path

Use DSH as the development Agent for the first version and prioritize reuse of the existing AgentBundle execution path. Investigate the current Application and Evaluator integration before introducing a different development backend or a separate execution mechanism.

Adapt that path to run the GEPA development task with the candidate ember-rsi skill and the fixed repository baseline. The fresh-context requirement in decision 14 and development-only cost scope in decision 18 still apply.

This selects an implementation direction; support for this specific repository development workload, its tool access, usage reporting, and output retention still needs to be verified.

## Confirmed decision 21: Bound development changes to the GEPA implementation

The development Agent may add or modify the GEPA Policy, necessary new plugin code, development self-tests, and run configuration. Integrate added components through the existing registration mechanism.

Keep the Runtime, RSI CLI, outer optimization flow, and formal acceptance scripts unchanged by the development Agent. The candidate skill is an input to development; only the Proposer modifies skill content in the optimization loop.

Report a missing framework capability separately rather than expanding the development scope to change the Runtime or CLI. The experiment is intended to test whether the skill guides development using the existing RSI capabilities.

## Confirmed decision 22: Let the development Agent design the implementation

Provide the development Agent with a fixed task brief describing the required GEPA behavior, reference material, allowed modification scope, and acceptance requirements. The Agent uses the candidate skill to decide how to express the implementation as Policies and plugins and which existing components to reuse.

The development Agent owns both the concrete implementation design and coding within the agreed scope. The experiment therefore exercises the skill's guidance for designing and implementing RSI strategies and plugins.

The existing review process still applies: acceptance criteria remain fixed within an attempt, and confirmed human feedback can update the requirements for later attempts. The GEPA task brief itself still needs to be prepared.

## Confirmed decision 23: Optimize only the skill entry and reference documentation

For the first version, the Proposer may optimize the [skill entry](../../../skills/ember-rsi/SKILL.md) and the Markdown guidance in the [reference documentation directory](../../../skills/ember-rsi/references/). Focus improvements on reusable guidance for Policy authoring, plugin development, and integration.

Keep example code and configuration assets unchanged, including the contents of `skills/ember-rsi/assets/`. The optimization target is the instructional documentation; development implementation files, the task brief, and formal acceptance scripts are outside the Proposer's edit scope.

The fixed examples remain available to the development Agent. Each attempt receives the selected version of the allowed documentation together with the unchanged supporting assets.

## Confirmed decision 24: Adapt the Harness² INV approach for skill proposals

Use the project's [INV prompt](../../../src/policies/harness2/prompts/invariant.md) as a reference for the Proposer's editing guidance within the agreed outer loop. Focus on reusable development behavior: action ordering, interface discovery, tool-error diagnosis, repeated ineffective work, and completion checks.

Provide the Proposer with the development Agent's available execution records, including tool calls, results, errors, and self-tests, together with the agreed development-cost feedback, preliminary acceptance result, and human feedback. Execution records support diagnosis; this does not reintroduce source comparison as an Evaluator responsibility. Preserve omissions and uncertainty in the available records.

For each proposal, connect an observed behavior to a concrete improvement hypothesis, the smallest useful documentation change, the expected behavior in a later attempt, and a check for that behavior. Prefer one focused, testable improvement; related changes may span several authorized documents. A single observation may justify trying a reversible change without establishing that the change will help.

Inspect existing guidance before adding a rule, clarify or merge overlapping instructions, and preserve useful behavior. Keep the improvement reusable for Policy and plugin development rather than storing a GEPA answer. A justified no-change result is valid when no useful supported edit can be formed.

The existing INV prompt uses verifier-blind execution evidence. This experiment adapts its diagnostic method while retaining the explicitly agreed cost, minimal-run feedback, and human review inputs; it does not copy that evidence restriction unchanged.

## Confirmed decision 25: Separate development problems from environment failures

Send development problems, such as incorrect interface use or missing registration steps, to the Proposer for diagnosis and skill improvement.

For failures confirmed to be unrelated to the generated implementation, such as an unavailable model service or a broken container environment, stop automatic optimization and retain the current skill and attempt records. After the environment is repaired, retry using the same skill version, fixed repository baseline, and fresh development context.

Keep an uncertain failure cause explicitly uncertain rather than attributing it to the skill. Preserve the failed attempt's diagnostic evidence. Environment recovery is not a skill revision or evidence of a skill improvement.

This decision does not add a Runtime pause or recovery capability. Follow the existing execution and recovery constraints when starting a retry; do not rewrite call receipts or checkpoints to force an interrupted call to resume.

## Confirmed decision 26: Request human input when the Proposer returns no change

When the Proposer returns `no-change`, stop automatic progression and use the human-review plugin to present the reason and unresolved problems. Wait for the user's next decision rather than automatically repeating development with unchanged inputs.

The user may provide additional guidance for another proposal attempt or end the current attempt while retaining its results. A no-change proposal is not evidence that GEPA passed acceptance. If the requirements remain unmet when the user stops, report the attempt as unfinished rather than successfully accepted.

This adds a human-input trigger to decision 9, including when automatic acceptance has not passed. It does not weaken the existing conditions for successful completion.

## Confirmed decision 27: Configure the development-round limit and set it to ten

Expose the outer experiment's development-attempt limit as a configurable `maxRounds` value. Set this experiment to `maxRounds: 10`; do not hard-code the limit into the loop implementation.

The limit includes the initial attempt with the original skill. Count a round when development starts, including attempts that later fail. User acceptance can end the experiment before the limit is reached.

At the limit, retain the results and report whether the requirements were met. Additional attempts require the user's decision and must follow the existing configuration and execution constraints rather than silently extending the run.

## Confirmed decision 28: Configure a sixty-minute development timeout

Expose the single-attempt development time limit as a configurable setting. Set it to 60 minutes for this experiment. It covers the development Agent's coding, self-tests, and repairs; an earlier completion proceeds to acceptance without waiting for the limit.

The Evaluator's independent acceptance check and human-review waiting are outside this development-stage timer. The existing Runtime wall-time budget still applies to the overall experiment, including review waiting.

If development times out, stop the owned development execution, retain the available implementation, execution records, and known usage, and report the attempt as unfinished. The attempt still counts toward the ten-round limit because development started. Timeout does not by itself establish whether the cause is a development problem or an environment failure; apply the distinction in decision 25 using the available evidence.

## Confirmed decision 29: Use ds-v4.1-flash for development and proposals

Use the user-selected model identifier `ds-v4.1-flash` for both roles. The Evaluator configures and invokes the DSH development Agent through the AgentBundle execution path. The Proposer uses the same model for its skill-editing work.

Keep each role's model and execution parameters fixed across the configured development rounds so changes in the skill can be compared under consistent conditions. This does not change the separate responsibilities or cost-accounting scopes of the two roles.

The model identifier is a configuration choice, not a verified availability claim. Endpoint connectivity, credentials, supported parameters, and usage reporting still need to be checked before a real run.

## Confirmed decision 30: Report tokens, model calls, and development duration

Use development-stage token usage as the main cost indicator supplied to the Proposer. Include model-call count and development duration as supporting indicators. Apply the development-only scope from decision 18 to all three: coding, self-tests, and repairs are included; independent evaluation, proposal work, and human waiting are excluded.

Use observed usage from the execution backend and keep unavailable values explicitly unknown. Do not substitute zero for missing measurements or present token usage as a verified monetary charge. Collection and coverage of these indicators still require integration verification.

## Confirmed decision 31: Use only the paper as the GEPA algorithm reference

Use the [GEPA paper v2](https://arxiv.org/abs/2507.19457v2) as the external reference for the GEPA algorithm. Give each development attempt the same paper version. Do not provide the official implementation or allow the development Agent to retrieve it; the proposed use of official code as a supplementary reference was not adopted.

Keep GEPA implementation code, implementation-derived summaries, and other external GEPA implementations out of the development reference material. References to code repositories in the paper do not authorize following those links to inspect implementations. Prepare any task-specific algorithm explanation from the paper itself.

The RSI repository, current candidate skill, and fixed RSI examples remain available as framework-development inputs. This restriction concerns external GEPA implementation references, not reuse of existing RSI components.

The task setup must respect this reference boundary. Its enforcement in the DSH execution environment still needs to be implemented and verified.

## Verification status

This continuation records design decisions only. No implementation or experiment was run for these changes, and no GEPA correctness or skill improvement has been demonstrated. Documentation formatting and local links were checked.

Current source inspection for cost accounting found:

- The [Manager](../../../src/runtime/manager/index.ts) accumulates reported metrics through `charge`, checks configured limits, persists budget usage, and records overall elapsed duration. The existing [Runtime service interface](../../../src/contracts/runtime/services.ts) exposes this charging method to plugins.
- The current [Pi Agent](../../../src/plugins/agent-pi/service.ts) charges model-call counts. Its provider configuration uses zero-valued price metadata, which does not establish that actual calls are free or that monetary cost is known. This implementation does not currently charge normalized token counts or monetary amounts into the ledger.
- The [SDK evaluator provenance adapter](../../../src/plugins/shared/evaluator-adapter/measurement.ts) records `usageKnown: false`. Full external development-Agent usage and total monetary cost therefore cannot be claimed as automatically covered by current framework accounting. Unknown usage must remain explicit.

These are static inspection findings, not measured usage from this experiment.

Inspection of the current [Pi Agent](../../../src/plugins/agent-pi/service.ts) also found that its supplied tools read authorized virtual files and invoke structured subagents; its instructions prohibit shell calls and host-file access. It cannot be assumed to perform the proposed repository development task unchanged. The existing [Agentbench configuration](../../../src/plugins/evaluator-agentbench/configuration.ts) selects an AgentBundle solver, and the repository includes a [DSH bundle example](../../../examples/harness/dsh-wikiskill/baseline/bundle.yaml). These establish an existing integration path to investigate, not verified support for this GEPA development workload. DSH is now selected in decision 20; the workload integration remains unverified.
