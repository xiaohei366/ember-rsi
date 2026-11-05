# Evaluator ownership of feedback-derived acceptance items

Date: 2026-11-05

Status: Confirmed design decision; not implemented.

This continues the [review waiting decision](2026-11-05-12-gepa-review-wait-timeout.md). It assigns responsibility for the accumulated acceptance checks from decisions 5 and 6 in the [initial design](../2026-11-04/2026-11-04-gepa-skill-optimization.md), within the [fixed original requirements](2026-11-05-05-gepa-review-feedback-scope.md).

## Confirmed decision 43: Let the Evaluator maintain subsequent acceptance items

The Evaluator maintains the acceptance items derived from the user's implementation feedback. For issues that can be checked automatically, incorporate an appropriate automatic check. For issues requiring judgment about algorithm logic, retain them in the human-review checklist for the user to assess.

Carry these items forward to subsequent attempts so previously reported problems remain visible. Prepare the applicable acceptance requirements before the next development attempt begins and keep them fixed during that attempt, as already agreed. The items check the original task requirements rather than introducing new requirements.

The Proposer receives the resulting feedback and improves only the authorized skill documentation. Neither the Proposer nor the development Agent owns or edits the formal acceptance criteria. The Evaluator maintains those criteria as part of the outer experiment; the Policy continues to orchestrate calls and human-review decisions.

Keep the existing minimal WorkBuddy execution scope and human logic review. Evaluator maintenance and execution of acceptance checks remain outside the development cost returned to the Proposer. Runtime and RSI CLI modification restrictions remain unchanged.

## Verification status

This document records the agreed responsibility only. Acceptance-item maintenance, feedback transfer, and execution of derived checks remain to be implemented and verified. No implementation, model call, or experiment was performed. Documentation formatting and local links were checked.
