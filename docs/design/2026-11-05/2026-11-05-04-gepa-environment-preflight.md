# Environment preflight before skill optimization

Date: 2026-11-05

Status: Confirmed design decision; not implemented or executed.

This continues the [fixed WorkBuddy task decision](2026-11-05-03-gepa-fixed-acceptance-task.md) and supplements the environment-failure and accounting rules in the [main continuation](2026-11-05-gepa-skill-optimization.md). Earlier decisions remain in effect.

## Confirmed decision 34: Run an environment preflight before development

Before starting the skill optimization loop, use the existing WorkBuddy evaluation configuration and a ready baseline AgentBundle to execute the selected acceptance task. Reuse the established DSH execution path to check that the required model service, DSH execution environment, and WorkBuddy task can work together.

Use the same task ID selected for the experiment. The [existing Harness² Recipe](../../../examples/harness/dsh-harness2/recipe.yaml) provides the WorkBuddy configuration reference; the preflight uses the single selected task rather than running that example's full optimization workflow.

Start the first development round only after this preflight completes successfully. Success means the execution path works; it does not require a correct task answer or demonstrate GEPA correctness. The preflight uses existing components and does not depend on a newly generated GEPA implementation.

If the preflight fails, resolve the setup or environment problem before starting development. Do not treat that result as a failure of the candidate skill or send it to the Proposer as a reason to modify the skill. A successful preflight also does not rule out later environment failures; decision 25 still applies during the loop.

The preflight does not consume one of the ten development rounds because no development attempt has started. Its usage is excluded from the development cost returned to the Proposer. Report available preflight usage separately when possible, consistent with best-effort overall accounting; missing usage remains unknown.

This decision does not authorize changes to the Runtime or RSI CLI. The concrete preflight configuration remains to be prepared as part of implementation.

## Verification status

This document records the agreed preflight design only. No preflight, model call, WorkBuddy execution, or GEPA experiment was performed. Environment readiness remains unverified. Documentation formatting and local links were checked.
