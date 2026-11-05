# GEPA skill optimization: development Evaluator plugin

Date: 2026-11-05

Status: Decision 52 confirmed; plugin implementation remains pending.

This confirms the RSI integration proposal in the [local development task decision](2026-11-05-23-gepa-local-development-task.md). The [Evaluator reuse direction](2026-11-05-21-gepa-evaluator-reuse.md) and [consolidated requirements](2026-11-05-20-gepa-consolidated-design-and-audit.md) remain unchanged.

## Decision 52: add a development Evaluator plugin in RSI

Add a small RSI development Evaluator plugin that delegates execution to the existing ember-evaluator SDK. It runs the local development task, retains the delivery and available evidence, organizes the agreed independent acceptance, and returns development-only cost and quality feedback.

The plugin translates observed outcomes into the previously agreed business flow: established development problems become feedback for the Proposer; confirmed environmental faults stop automatic skill optimization. An expected development failure must not cross the Runtime call boundary as an undifferentiated operation exception that aborts the whole experiment. Cancellation, unknown execution, and infrastructure failures must retain their actual meaning.

The outer Policy still owns orchestration and decisions. The Evaluator finishes before the separate human-review plugin waits for a response. Reuse the existing AgentBundle and SDK execution capabilities; this decision does not authorize a replacement execution engine or a change to RSI Runtime or CLI. Register the new plugin through the existing extension-loading facilities.

## Next discussion: failures with an uncertain cause

[Decision 25](2026-11-05-gepa-skill-optimization.md) already requires preserving uncertainty rather than blaming the skill; timeout alone does not establish a cause. The next proposal is to request human judgment before automatic skill revision or another development attempt when available evidence cannot distinguish a development problem from an environmental fault.

Existing SDK error metadata and execution evidence can inform that judgment, but an error category or timeout is not by itself proof of causal responsibility. Human routing for these uncertain cases is still a proposal, not a newly confirmed decision.

## Verification

Documentation-only change. Checked existing decisions and the SDK error metadata/classification interfaces, local links, and text formatting. No source code or configuration was changed; no tests, model requests, or experiments were run in this step.
