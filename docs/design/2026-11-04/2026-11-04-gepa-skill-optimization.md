# GEPA implementation through an outer skill optimization experiment

Date: 2026-11-04

Status: Design discussion in progress. Only confirmed decisions are recorded below.

## Goal

Use an outer RSI experiment to improve the repository's [ember-rsi skill](../../../skills/ember-rsi/SKILL.md), with AI implementing a GEPA Policy as the development task. The intended outputs are a working GEPA implementation and an improved skill supported by evaluation results.

## Confirmed decision 1: Repeat development from a fixed starting point

Each skill version is evaluated by having an AI attempt the same GEPA implementation task from the same repository starting point. A later attempt does not inherit code changes produced by an earlier attempt.

The outer loop is:

1. Supply a skill version to the AI performing the GEPA development task.
2. Start that attempt from the fixed repository baseline.
3. Evaluate the resulting implementation and collect feedback.
4. Use that feedback to revise the skill and repeat the task from the same baseline.

Compare the attempts and retain a qualifying GEPA implementation alongside the selected skill version. Repeating development has a higher execution cost, but avoids mistaking accumulated code progress for an improvement in the skill.

The exact baseline, remaining evaluation details, execution conditions, and budgets remain undecided.

## Confirmed decision 2: Improve reusable Policy and plugin authoring guidance

The optimization target is the general ember-rsi skill, with emphasis on writing Policies and adding plugins. GEPA is the development task used in this experiment, rather than the intended scope of the resulting skill.

Lessons from the GEPA attempts should improve reusable guidance for these activities. The intended benefit extends to future Policy and plugin development; improvement on GEPA alone does not establish that broader benefit.

## Confirmed decision 3: Combine execution checks with human logic review

Evaluation combines two forms of feedback:

1. The AI runs the produced implementation and records whether the first run succeeds, together with errors and the cost of any subsequent repairs. A later successful run does not erase the earlier failure.
2. The user reviews the implementation logic and identifies deviations from the intended design. Successful execution alone does not establish logical correctness.

The user's findings and execution feedback guide revisions to the skill's reusable instructions. Following decision 1, evaluate each revised skill through a fresh development attempt from the fixed repository baseline. Repeat review and skill revision when deviations remain.

Repair limits and stopping conditions remain to be agreed. No numerical scoring formula has been selected.

## Confirmed decision 4: Measure the first formal acceptance run separately from development

First-run success means that the first formal acceptance run succeeds after the development AI declares its implementation complete. The AI may run self-tests and repair errors during development. All development-time testing and repair costs count toward the attempt's total cost.

Record the first formal acceptance result separately from eventual success and total development cost. Repairs after a failed acceptance run do not change its original first-run result.

## Confirmed decision 5: Turn review feedback into recurring acceptance checks

Each issue identified by the user informs both a reusable skill improvement, where applicable, and an acceptance check for subsequent attempts. Keep task-specific acceptance details in the GEPA checks while placing general Policy and plugin authoring lessons in the skill.

Automate checks whose expected behavior can be tested. Preserve issues requiring design judgment in a human review checklist. Subsequent attempts are checked against the accumulated requirements so previously identified problems remain visible if they recur.

For example, a failure to release an instance after an execution error can lead to general resource-cleanup guidance in the skill and an automated failure-path check. This is an illustrative check, not a defect observed in an executed attempt.

## Confirmed decision 6: Keep formal acceptance under outer-loop control

The outer loop owns the formal acceptance scripts and passing criteria and runs the acceptance checks after implementation delivery. The development AI can read the requirements and create and run its own tests, but cannot modify the formal acceptance scripts or passing criteria.

The user retains responsibility for reviewing implementation logic. Acceptance additions derived from the user's feedback are maintained by the outer loop and applied before the next attempt starts. The criteria remain fixed within each attempt.

This separation does not require an additional reviewing model. Independent acceptance files and execution, together with the user's logic review, are the agreed starting approach.

## Confirmed decision 7: Evaluate the skill through a repository development task

The development task is to add the GEPA Policy and any necessary plugins within the RSI source repository. Each attempt uses an isolated copy of the fixed repository baseline, as specified in decision 1.

The Evaluator invokes a development Agent using the candidate skill to perform this task. After development, it collects source changes, runs the independent acceptance checks, and records execution results, costs, and identified problems as evaluation evidence. Source comparison supports review; the execution checks and human logic review from decision 3 remain required.

The Proposer uses the evaluation findings and available human feedback to improve the skill instructions. The next evaluation tests that revised skill through a fresh development attempt. Preserve the generated GEPA implementations as reviewable outputs rather than carrying their code changes into subsequent development attempts.

The mechanism for waiting and resuming remains under discussion; decision 9 defines when human review is requested.

## Confirmed decision 8: Let the outer Policy control the loop

The Evaluator completes one development evaluation and returns its results. The outer Policy then decides whether to invoke the Proposer for another skill revision, wait for the user's review, or end the loop. The Evaluator does not own these continuation decisions or remain active solely to wait for human feedback.

The Proposer owns the skill changes derived from the supplied findings and feedback. The Policy coordinates the next evaluation of the revised skill from the fixed repository baseline.

This is the intended responsibility split. The human-review waiting mechanism still needs to be designed and implemented; it is not an existing Policy pause capability established by this discussion.

## Confirmed decision 9: Request human review after automatic acceptance passes

Within the agreed budget, automatic acceptance findings that identify implementation problems are sent to the Proposer for skill revision, followed by a fresh development evaluation. When automatic acceptance passes, the Policy waits for the user's logic review before proceeding.

If the user identifies problems, incorporate that feedback into the acceptance requirements and the next skill revision, then evaluate another fresh development attempt. If the user confirms that the implementation meets the requirements, end the loop and retain the reviewed GEPA implementation and its corresponding skill version.

Passing automatic checks alone does not authorize successful completion. Budget limits, infrastructure failures, and the interface for submitting human feedback still need to be specified.

## Confirmed decision 10: Integrate human feedback into RSI

RSI must execute and control the optimization loop, including receiving human review decisions. A conversational agreement or an assistant manually coordinating separate runs is not a substitute for a feedback interface available to the Policy.

The integration must associate the user's feedback or approval with the implementation being reviewed and expose that response to the Policy. The proposed chat-only entry point was not adopted. Decision 11 defines the command ownership and process lifetime, and decision 12 defines the communication mechanism. The exact contract and record format remain to be agreed.

## Confirmed decision 11: Provide the feedback command within the review plugin

The first version adds a human-review plugin and a standalone feedback command supplied by that plugin. Use the existing plugin loading mechanism to register the review operation. Do not modify the Runtime or the RSI CLI to add commands, dispatch hooks, or suspension behavior.

The feedback command is invoked independently of the main `ember-rsi` command. It submits the user's decision and comments to the review plugin for the corresponding review request. The review operation returns the submitted result to the Policy, which retains ownership of continuation and completion decisions.

Keep the RSI process running while the review operation waits. Waiting remains subject to the existing wall-time budget and cancellation signal. The first version does not promise recovery of an interrupted waiting operation after process termination.

The plugin owns its review data under `.rsi/`; feedback submission must not edit Manager call receipts, checkpoints, or experiment facts to force continuation. Exact command syntax remains to be settled; decision 12 defines the communication mechanism.

## Confirmed decision 12: Use plugin-owned files for request and response exchange

The review operation writes a pending request with a unique review identifier under `.rsi/` and waits. The standalone feedback command targets that identifier and saves the user's approval or revision feedback. The waiting operation reads and validates the corresponding response before returning it to the Policy.

The operation and command share the plugin's request and response handling logic. The review identifier ties feedback to the correct attempt and reviewed implementation. This communication uses plugin-owned files rather than new Runtime or RSI CLI capabilities.

## Confirmed decision 13: Present a review summary with an implementation index

The review plugin must present the Evaluator's results and make the associated implementation available for human inspection before feedback is submitted. A request identifier and feedback submission command alone are insufficient for the user to review the work.

When review is requested, show the review identifier and inspection instructions in the running terminal. Provide a concise terminal summary, a local report under `.rsi/`, and a plugin-owned `show <review-id>` command for viewing the saved review material. These are planned plugin capabilities, not existing commands.

The review summary covers implementation changes, execution and acceptance results, measured costs, and review focus. Execution results distinguish first formal acceptance from later success. Costs include elapsed time, model calls, and token usage when available; missing values remain unknown. Review focus identifies reported problems and requirements still needing human judgment.

Present implementation changes as a navigation index:

- Identify newly added Policies and plugins and briefly state their responsibilities.
- Group affected files by responsibility, such as Policies, plugins, tests, and configuration, where applicable.
- For each file, show its path, change type such as added or modified, and a short description of its purpose or change.
- Provide paths or links into the retained implementation so the user can inspect the relevant source directly.

Keep full diffs, source code, and logs available as supporting material rather than expanding them in the main implementation summary. The index should help the user locate the relevant changes without requiring a detailed code walkthrough in the report. Evaluator results supply the evidence; the review plugin formats and presents that evidence for the user's logic review.

## Verification status

This is an agreed experiment design direction. No experiment has been run, no GEPA implementation has been verified, and no skill improvement has been measured as part of this discussion.

Static inspection found feedback inputs in the [Proposer contract](../../../src/contracts/plugin-types/proposer.ts) and structured observations in the [Memory contract](../../../src/contracts/plugin-types/memory.ts). The current [CLI](../../../src/entries/cli/index.ts) has no human-review pause command. Running bounded stages with user review between them is a possible implementation approach; the complete development evaluation and review workflow has not been implemented or tested.

The current [Agentbench Evaluator](../../../src/plugins/evaluator-agentbench/service.ts) executes an SDK-backed evaluation and records measurements. This inspection does not establish that the proposed repository development task, source comparison, or human-review integration is already available.

Targeted static inspection of human-feedback integration found:

- The current [plugin contracts](../../../src/contracts/plugin-types/index.ts) provide no dedicated human-review request and decision interface. [Policy execution](../../../src/runtime/policy/index.ts) can invoke registered operations and await their outputs, so a new review operation can participate in the normal flow.
- Neither the [CLI](../../../src/entries/cli/index.ts) nor the [Web control routes](../../../src/entries/web/server.ts) currently exposes a human-review submission entry point. A review plugin needs a corresponding submission interface; adding an operation alone does not supply one.
- A plugin can wait while its host process stays alive, but the [Manager](../../../src/runtime/manager/index.ts) continues counting wall time. The [call executor](../../../src/runtime/manager/calls.ts) replays successful receipts and rejects resumption of calls with unfinished or failed effects. Persisting a review request alone therefore does not establish safe recovery after interrupting a waiting call.

A bounded, cancellable review operation with a plugin-owned submission command is the selected first-version direction. Durable suspension and restart would require additional Runtime support and are outside that scope. The review workflow has not been implemented or verified through execution.

Inspection of the [plugin loader](../../../src/runtime/loaders/plugins.ts) confirms that an extension can register its operation through `index.mjs` and `register(registry)` using existing loading paths. The [Registry](../../../src/runtime/registry/index.ts) registers an operation's contract with its definition. A standalone feedback program can be packaged alongside the plugin without extending the RSI CLI command dispatcher; its communication with the waiting operation still needs implementation and verification.

The existing [Runtime service interfaces](../../../src/contracts/runtime/services.ts) expose `readMeasurement` and `readEvidence`, and the [Measurement protocol](../../../src/contracts/models/measurement.ts) supports metrics, item results, diagnostics, and evidence references. These interfaces provide a path for a review plugin to read evaluation results. They do not establish that the proposed development Evaluator already records source diffs, complete acceptance details, or costs. The current [SDK provenance adapter](../../../src/plugins/shared/evaluator-adapter/measurement.ts) records `usageKnown: false`; review presentation must preserve unknown or missing information rather than inventing values or treating missing cost as zero.
