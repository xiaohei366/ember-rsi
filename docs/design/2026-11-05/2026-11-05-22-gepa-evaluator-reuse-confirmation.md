# GEPA skill optimization: Evaluator reuse confirmed

Date: 2026-11-05

Status: Decision 50 explicitly confirmed; concrete task packaging remains under discussion.

This records the user's approval of the [Evaluator reuse proposal](2026-11-05-21-gepa-evaluator-reuse.md). The [consolidated requirements](2026-11-05-20-gepa-consolidated-design-and-audit.md) remain in force.

## Confirmed direction

Proceed with the existing ember-evaluator engine and its DSH AgentBundle execution, artifact collection, trace retention, and available usage accounting. Implement the repository-development workload and RSI business integration around those capabilities. Extend Evaluator only for demonstrated gaps. RSI Runtime and CLI remain unchanged.

The prior component simulation establishes a reusable SDK delivery/accounting path, not completion of the production integration or the outer RSI loop. This approval does not change the agreed simulation-first validation order.

## Next discussion: local task packaging

Propose using Evaluator's existing local Harbor task format for the GEPA development workload. Package the fixed repository baseline, paper, original task requirements, development environment definition, and delivery paths. Supply the current skill through the development AgentBundle; the fixed task package must not embed a stale skill candidate. Feedback-derived acceptance items retain their agreed per-attempt handling.

This would keep GEPA-specific task content outside Evaluator's generic execution code. The choice of this concrete packaging format is pending user confirmation and real integration verification; it is not implied by approval of engine reuse.

## Verification

Documentation-only follow-up. Checked the existing design and current local Harbor task preparation code, document links, and text formatting. No code or configuration was changed, and no new test, model request, or experiment was run in this step.
