# Overall time limit for the GEPA skill experiment

Date: 2026-11-05

Status: Confirmed design decision; not implemented.

This continues the [selected WorkBuddy task](2026-11-05-17-gepa-selected-workbuddy-task.md) and sets the overall limit referenced by the [human-review waiting rule](2026-11-05-12-gepa-review-wait-timeout.md). Earlier decisions remain in effect.

## Confirmed decision 48: Configure a seventy-two-hour overall limit

Set the overall experiment time limit to 72 hours and keep it configurable. Use the existing Recipe budget field, `budget.elapsedWallMs`, with `259200000` milliseconds for this experiment. Do not add a separate Runtime timing mechanism.

The overall limit includes development, independent acceptance, Proposer execution, and human-review waiting. Use the existing Runtime experiment clock; do not reset or extend it when entering a new development round or review wait.

If the overall limit expires before successful completion, stop progression according to the existing Runtime cancellation and budget behavior, retain the available results, and describe the experiment as unfinished. The ten-round limit remains a maximum, not a guarantee that ten rounds will fit within the time budget.

The 60-minute development limit and 24-hour human-review waiting limit still apply to their respective stages. Each stage is also bounded by the remaining overall time. This setting does not change the development-only cost scope returned to the Proposer or authorize Runtime or RSI CLI changes.

## Verification status

The current [Harness² Recipe](../../../examples/harness/dsh-harness2/recipe.yaml) provides an existing example of `budget.elapsedWallMs: 259200000`. This decision records the same time allowance for the planned experiment; no experiment configuration or runtime code was changed. No timer behavior, model call, or experiment was executed. Documentation formatting and local links were checked.
