# Selected WorkBuddy task for the GEPA skill experiment

Date: 2026-11-05

Status: Confirmed design decision; not implemented or executed.

This continues the [staged integration decision](2026-11-05-16-gepa-staged-integration.md) and fills in the task selection left open by the [fixed-task rule](2026-11-05-03-gepa-fixed-acceptance-task.md). Earlier decisions remain in effect.

## Confirmed decision 47: Use the board-material timeline task

Set this experiment's WorkBuddy task ID to `workbuddy/board-material-update-timeline-excel`. Use this task for the environment preflight. Once preflight succeeds, keep the same task ID for every development round's formal acceptance run.

The task setting remains configurable for other experiments. Do not switch tasks within this experiment to accommodate a failed development attempt. A preflight failure still requires resolution before development starts, as specified by the [preflight decision](2026-11-05-04-gepa-environment-preflight.md).

The acceptance scope remains one task and one minimal GEPA round, using the agreed Office prompt target, model choices, and fresh acceptance process. Selecting the task does not imply that its environment is ready or that it has passed preflight.

## Verification status

The task ID is present in the current [Harness² Recipe](../../../examples/harness/dsh-harness2/recipe.yaml). This confirms an existing configuration reference only. No task execution, preflight, implementation, or model call was performed. Documentation formatting and local links were checked.
