# GEPA implementation scope and WorkBuddy acceptance

Date: 2026-11-05

Status: Design discussion in progress.

This continues the [GEPA skill optimization design](2026-11-05-gepa-skill-optimization.md). It specifies the implementation scope and the preliminary acceptance dataset. Earlier decisions remain in effect, including paper-only algorithm references, human logic review, and development-only cost feedback.

## Confirmed decision 32: Implement the main algorithm and check one WorkBuddy task

Implement the GEPA paper's main algorithm in full. Keep automatic acceptance lightweight: run one minimal round of the generated GEPA experiment using exactly one task from the WorkBuddy dataset already integrated with RSI. The small acceptance workload does not reduce the required algorithm implementation scope.

Reuse the existing WorkBuddy evaluation integration. The [Harness² Recipe](../../../examples/harness/dsh-harness2/recipe.yaml) configures `evaluator.agentbench` with benchmark `workbuddy`, scenario `office`, and solver `agentbundle`, and supplies explicit WorkBuddy task IDs. The exact task ID for this experiment remains to be selected.

Apply the existing first-formal-run rule. Acceptance checks whether the minimal round finishes normally; it does not require a full benchmark campaign or demonstrated optimization gains. One task limits the dataset size, not necessarily the number of model calls or executions needed for that round. Human review remains responsible for assessing algorithm logic, including behavior not exercised by this run.

The independent acceptance run remains outside the development cost returned to the Proposer. The development Agent's own tests and repairs remain inside that cost scope.

## Verification status

The current Harness² Recipe and its [README](../../../examples/harness/dsh-harness2/README.md) were inspected to confirm the existing WorkBuddy configuration path. This is static configuration evidence, not a successful WorkBuddy or GEPA execution. Environment readiness, the selected task's availability, and the new GEPA integration remain unverified.

No implementation or experiment was run for this decision. Documentation formatting and local links were checked.
