# Office prompt as the minimal GEPA acceptance target

Date: 2026-11-05

Status: Confirmed design decision; not implemented.

This continues the [Evaluator acceptance-item responsibility](2026-11-05-13-gepa-evaluator-acceptance-items.md) and specifies the optimization target used by the [minimal WorkBuddy acceptance run](2026-11-05-02-gepa-workbuddy-acceptance.md). Earlier decisions remain in effect.

## Confirmed decision 44: Optimize the Office prompt during GEPA acceptance

Reuse the existing [DSH Harness² baseline AgentBundle](../../../examples/harness/dsh-harness2/baseline/bundle.yaml) for the minimal GEPA acceptance task. The generated GEPA implementation optimizes only its [Office prompt](../../../examples/harness/dsh-harness2/baseline/plugins/office-base/prompts/office-discipline.md), at bundle-relative path `plugins/office-base/prompts/office-discipline.md`.

Keep all other Bundle files fixed during that acceptance run, including its existing skills, execution code, dependency declarations, and configuration. Define the acceptance optimization target accordingly; the existing Harness² target is broader and cannot be reused unchanged for this restriction.

Run this target against the configured single WorkBuddy task for one minimal GEPA round, in the already agreed new acceptance process. Use the same baseline Bundle inputs across outer development rounds so the acceptance task remains consistent.

This selects a small acceptance workload; it does not reduce the requirement to implement the paper's main algorithm. The outer experiment still optimizes the general ember-rsi skill documentation. The Office prompt is the target of the generated GEPA implementation's test run, not an additional file that the outer skill Proposer may edit.

## Verification status

Static inspection of the [Office Bundle plugin](../../../examples/harness/dsh-harness2/baseline/plugins/office-base/index.js) found that it reads the Office prompt and existing skills into a system-prompt section. The current [Harness² target](../../../examples/harness/dsh-harness2/target.yaml) permits changes to both the prompt and a skill directory, so a narrower target is needed for this acceptance task.

These are source inspection findings, not evidence of successful prompt loading or use during a real run. No acceptance configuration, implementation, model call, or WorkBuddy execution was performed. Documentation formatting and local links were checked.
