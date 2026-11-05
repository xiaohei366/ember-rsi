# Model choices for the GEPA acceptance workload

Date: 2026-11-05

Status: Confirmed design decision; not implemented.

This continues the [Office prompt acceptance target](2026-11-05-14-gepa-office-prompt-acceptance-target.md) and supplements decision 29 in the [main continuation](2026-11-05-gepa-skill-optimization.md), which already selected the development Agent and outer skill Proposer models.

## Confirmed decision 45: Use ds-v4.1-flash for both acceptance roles

Use `ds-v4.1-flash` for both additional roles in the minimal GEPA acceptance workload:

- The DSH Agent that executes the selected WorkBuddy task using the Office AgentBundle.
- The model that the generated GEPA implementation invokes to propose Office prompt changes.

Keep these model selections and each role's execution parameters fixed across the outer experiment's development rounds. Together with decision 29, the development Agent, outer skill Proposer, WorkBuddy task Agent, and GEPA prompt-proposal model all use the same model identifier. Their responsibilities and accounting scopes remain separate.

Use the selected WorkBuddy task model during the environment preflight as well. Independent acceptance and preflight usage remain outside the development cost returned to the outer Proposer. Development-Agent self-tests and repairs remain within that cost, as previously agreed.

## Verification status

These are user-selected model settings, not verified availability or compatibility claims. Endpoint connectivity, credentials, supported parameters, and usage reporting remain to be checked before execution. No configuration, implementation, model call, or experiment was run. Documentation formatting and local links were checked.
