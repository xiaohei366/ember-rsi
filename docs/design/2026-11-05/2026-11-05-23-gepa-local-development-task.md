# GEPA skill optimization: local development task package

Date: 2026-11-05

Status: Decision 51 confirmed; production task packaging is not implemented yet.

This confirms the task-packaging proposal in the [Evaluator reuse confirmation](2026-11-05-22-gepa-evaluator-reuse-confirmation.md), replacing its pending status for that choice. The [Evaluator reuse decision and verification limits](2026-11-05-21-gepa-evaluator-reuse.md) remain applicable.

## Decision 51: use a local task package

The first version will use ember-evaluator's existing local Harbor task format to represent the GEPA repository-development task.

The package supplies the fixed RSI repository baseline, GEPA paper, original development requirements, development environment definition, and declared delivery paths. GEPA-specific task content belongs in this package; execution continues through the existing Evaluator and DSH AgentBundle path.

Supply each round's skill candidate through the development AgentBundle rather than embedding a fixed copy in the task package. Preserve the agreed handling of feedback-derived acceptance items, whose version is fixed within each attempt. Each development attempt still starts from the same repository baseline and a fresh Agent session.

Independent formal acceptance remains a separate fresh-process step using the agreed WorkBuddy task. A local task's delivery check does not replace that acceptance. RSI Runtime and CLI remain unchanged.

## Next open integration choice

Decide whether to add a small RSI development Evaluator plugin that invokes the shared SDK execution path and returns development-specific feedback. The current [Agentbench Evaluator](../../../src/plugins/evaluator-agentbench/service.ts) throws on relevant nonzero SDK exit codes, so its existing behavior cannot simply stand in for the agreed development-failure feedback flow. This plugin assembly choice remains a proposal; no second execution engine is needed.

## Verification

Documentation-only change. Checked the preceding decisions, current RSI Evaluator result handling, links, and text formatting. No production code, task configuration, or dependency was changed. No test, model request, or real development/WorkBuddy run was executed in this step.
