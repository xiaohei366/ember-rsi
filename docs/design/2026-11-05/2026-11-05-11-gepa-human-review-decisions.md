# Human review decisions for the skill optimization loop

Date: 2026-11-05

Status: Confirmed design decision; not implemented.

This continues the [fresh-process acceptance decision](2026-11-05-10-gepa-fresh-process-acceptance.md) and specifies the review responses handled by the plugin-owned feedback interface from the [initial design](../2026-11-04/2026-11-04-gepa-skill-optimization.md). Earlier decisions remain in effect.

## Confirmed decision 41: Support three human review decisions

The human-review plugin's feedback command supports these three decisions:

| Decision | Meaning | Loop outcome |
| --- | --- | --- |
| Continue optimization | Submit implementation issues for the Proposer to address through skill changes. | Continue through the existing proposal and evaluation flow, subject to remaining rounds and budgets. |
| Accept | Confirm that the reviewed implementation meets the requirements. | End successfully and retain the reviewed GEPA implementation with the skill version that produced it. |
| Stop experiment | End the experiment without declaring the requirements satisfied. | Retain available results and report the experiment as unfinished. |

Bind each submitted decision to the existing review request identifier and the implementation under review. The review plugin returns the decision; the outer Policy remains responsible for continuation or termination. The command is supplied by the plugin, without extending the RSI CLI or Runtime.

Successful completion still requires the existing automatic acceptance and human approval conditions. A continue decision does not silently extend the round limit or budget. A stop decision is distinct from acceptance and does not promise durable pause-and-resume support.

## Verification status

This document records the agreed review decisions only. The command, response validation, and Policy handling remain to be implemented and verified. No implementation, model call, or experiment was performed. Documentation formatting and local links were checked.
