# Fresh-process acceptance of the GEPA delivery

Date: 2026-11-05

Status: Confirmed design decision; not implemented.

This continues the [Proposer history-access decision](2026-11-05-09-gepa-proposer-history-access.md) and supplements the [WorkBuddy acceptance scope](2026-11-05-02-gepa-workbuddy-acceptance.md). Earlier decisions remain in effect.

## Confirmed decision 40: Start formal acceptance in a new process

After the development Agent delivers its implementation, the Evaluator starts a new process using the delivered code and configuration for formal acceptance. Do not reuse an experiment process or live service left running by the Agent's self-tests, or treat a self-test result as the formal acceptance result.

Keep the acceptance workload unchanged: the same configured WorkBuddy task, with a dataset size of one task and one minimal GEPA round. Preserve the first-formal-run result independently of any later success. Human logic review remains required.

The acceptance startup must use explicit delivery inputs and its own run outputs rather than relying on temporary self-test state. A new process alone does not establish a clean filesystem or container; the concrete startup and resource handling still need implementation and verification. The Evaluator owns the acceptance process and its cleanup, including on failure or cancellation.

This independent acceptance execution remains outside the development-stage timeout and the development cost returned to the Proposer. Existing overall experiment budgets and the restriction against Runtime or RSI CLI changes remain in effect.

## Verification status

This document records the agreed acceptance-process boundary only. No process-isolation behavior, implementation, model call, or WorkBuddy execution was tested. Documentation formatting and local links were checked.
