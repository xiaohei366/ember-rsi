# Quality-first comparison of skill versions

Date: 2026-11-05

Status: Confirmed design decision; not implemented.

This continues the [historical skill starting-point decision](2026-11-05-07-gepa-historical-skill-bases.md) and defines the comparison priority left open there. The evaluation and cost scopes in the [main continuation](2026-11-05-gepa-skill-optimization.md) remain unchanged.

## Confirmed decision 38: Prefer quality before development cost

When comparing skill versions or choosing a proposal starting point, assess implementation quality first: whether the minimal acceptance run succeeds and whether the implementation addresses the issues raised in human review. Preserve the distinction between the first formal acceptance result and any later success.

When versions have comparable observed quality, prefer the version with lower development-stage token usage. Model-call count and development duration remain supporting cost indicators. Apply the existing development-only accounting scope; Evaluator inspection, independent acceptance, Proposer work, and human waiting remain excluded.

Lower token usage does not compensate for a known execution failure or an unresolved review issue. Missing review evidence or unavailable usage must remain unknown rather than being treated as a pass or zero cost. This priority rule does not by itself establish that one observed run proves a general skill improvement.

The Proposer's explanation for selecting a historical base should follow this priority and cite the available results. Existing human acceptance, round-limit, and no-change rules remain in effect; comparison alone does not authorize successful completion.

## Verification status

This document records the agreed comparison priority only. No selector, proposal behavior, model call, or experiment was implemented or executed. Documentation formatting and local links were checked.
