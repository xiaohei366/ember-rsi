# Historical skill versions as proposal starting points

Date: 2026-11-05

Status: Confirmed design decision; not implemented.

This continues the [Evaluator review-summary decision](2026-11-05-06-gepa-evaluator-review-summary.md) and supplements the proposal process in the [main continuation](2026-11-05-gepa-skill-optimization.md). Earlier decisions remain in effect.

## Confirmed decision 37: Allow proposals to start from a historical skill version

Preserve each development round's skill version and associated evaluation results as experiment artifacts under `.rsi/`. Keep the relationship between the skill, development attempt, and available human feedback identifiable so the Proposer can use that history when choosing a starting point.

Allow the Proposer to select a historical skill version as the base for its next modification instead of always editing the most recent version. Require it to identify the selected base and explain the choice using available evaluation results, development evidence, or review feedback. This supports returning to an earlier starting point when a later revision appears to have regressed.

Preserve previous versions and results rather than overwriting them when selecting a base. The resulting proposal remains limited to the authorized skill entry and reference documentation. It must still be evaluated through a fresh development attempt from the fixed repository baseline and fresh Agent context; selecting an older skill does not carry forward its generated GEPA code.

The existing round limit, no-change handling, and human acceptance rules remain in effect. Choosing a historical base does not reset the experiment's consumed rounds or establish that the next proposal is an improvement. The exact comparison rule for preferring one version over another remains to be discussed.

## Verification status

This is a proposal-history design decision only. Integration with existing candidate storage and proposal interfaces remains to be implemented and verified within the restriction against Runtime and RSI CLI changes. No implementation, model call, or experiment was performed. Documentation formatting and local links were checked.
