# Human feedback against fixed GEPA requirements

Date: 2026-11-05

Status: Confirmed design decision; not implemented.

This continues the [environment preflight decision](2026-11-05-04-gepa-environment-preflight.md) and clarifies the human-feedback rules in the [initial design](../2026-11-04/2026-11-04-gepa-skill-optimization.md) and [main continuation](2026-11-05-gepa-skill-optimization.md). Earlier decisions remain in effect.

## Confirmed decision 35: Treat review issues as unmet original requirements

The user does not intend to add requirements during this experiment. Treat all problems raised through human logic review as failures to meet the original requirements. Do not introduce a separate new-requirement classification or requirement-change workflow for the first version.

Send these issues to the Proposer with the available development evidence so it can improve the reusable skill guidance. Preserve task-specific details in the accumulated acceptance checks or human-review checklist, as agreed in decision 5. These additions clarify how the original requirements are checked; they do not expand the development task.

Keep the existing ownership boundaries: the Proposer edits only the authorized skill documentation, while the outer loop maintains formal acceptance requirements. Acceptance remains fixed within each development attempt. This decision concerns human-reported implementation issues and does not change the separate handling of confirmed environment failures or the user's ability to accept or end the experiment.

## Verification status

This document records the agreed treatment of human feedback only. No implementation, model call, or experiment was performed. Documentation formatting and local links were checked.
