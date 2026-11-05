# GEPA skill optimization: human judgment for uncertain failures

Date: 2026-11-05

Status: Decision 53 confirmed; failure-review response details remain under discussion.

This confirms the uncertain-failure proposal in the [development Evaluator plugin decision](2026-11-05-24-gepa-development-evaluator-plugin.md). It supplements [decision 25 on failure attribution](2026-11-05-gepa-skill-optimization.md) without changing the existing development/environment distinction.

## Decision 53: request human judgment when the cause is unclear

When the available evidence cannot establish whether a failure came from the generated implementation or the environment, retain the uncertain classification and request the user's judgment through the existing human-review plugin. Do not automatically revise the skill or begin another development attempt while the cause is unresolved.

The review material identifies the failed stage, relevant logs, available delivery and usage evidence, and what remains unclear. A timeout alone must not be presented as proof of either a development defect or an environmental fault.

The Evaluator returns its findings; the outer Policy invokes the review operation and applies the response. Once the cause is resolved, follow the agreed routing: development issues inform the Proposer; environmental repair is followed by a fresh attempt with the same skill and fixed repository baseline, subject to existing budgets and recovery constraints.

Use the existing live-process, plugin-owned feedback mechanism. The [review waiting limit](2026-11-05-12-gepa-review-wait-timeout.md), overall budget, cancellation behavior, and absence of a durable process-restart guarantee remain unchanged. No Runtime or RSI CLI change is implied.

## Next discussion: express the intended action in failure feedback

Propose explicit responses for the uncertain-failure review: identify a development problem and supply diagnostic feedback, or confirm that the environment is repaired and request a same-skill retry. Stopping unfinished remains available. Merely diagnosing an environmental problem must not trigger a retry before repair.

These response details are pending confirmation. They specialize the failure-review context rather than changing successful implementation acceptance or silently extending the [three existing implementation-review decisions](2026-11-05-11-gepa-human-review-decisions.md).

## Verification

Documentation-only change. Checked the earlier failure, feedback, and waiting-limit decisions; verified local links and text formatting. No source code or configuration was changed, and no test, model request, or experiment was run.
