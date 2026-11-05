# Fixed WorkBuddy task across skill optimization rounds

Date: 2026-11-05

Status: Confirmed design decision; not implemented.

This continues the [GEPA WorkBuddy acceptance design](2026-11-05-02-gepa-workbuddy-acceptance.md) and supplements decision 32. All earlier decisions remain in effect.

## Confirmed decision 33: Configure one task and keep it fixed across rounds

Expose the WorkBuddy acceptance task ID as an experiment configuration setting. Select one supported task before the skill optimization experiment starts, and use that same task for every development round's formal acceptance run in that experiment.

Do not rotate or randomly select a different task between rounds. Keeping the task fixed avoids introducing task-selection differences into comparisons of execution results and development cost. It does not remove model or environment variability or establish generalization beyond that task.

The task ID may differ between separately configured experiments. The specific ID for the first experiment remains to be selected; this decision does not choose a default task or change the existing development-only cost scope.

## Verification status

This is a configuration and comparison rule only. No implementation, model call, or WorkBuddy execution was performed. Documentation formatting and local links were checked.
