# GEPA skill optimization: fixed acceptance startup

Date: 2026-11-05

Status: Decision 57 confirmed; delivery paths and acceptance runner remain to be implemented.

This confirms the startup proposal in the [skill-loading decision](2026-11-05-28-gepa-skill-loading.md) and specializes the existing [fresh-process acceptance requirement](2026-11-05-10-gepa-fresh-process-acceptance.md).

## Decision 57: use a fixed startup interface

For the first version, require the development Agent to deliver a runnable Recipe and plugin-loading entry at locations specified in advance by the task package. The Evaluator's fixed acceptance runner loads these explicit inputs and starts formal acceptance in a new process.

Keep the startup convention consistent across attempts. The Evaluator does not need to infer startup commands from the Agent's narrative or reuse a running self-test process. The concrete relative paths will be set when assembling the fixed task package.

The Agent still designs the GEPA implementation's internal Policy/plugin structure. This delivery convention does not require a separate implementation index. Formal acceptance scripts and passing criteria remain owned by the outer experiment and outside the development Agent's edit scope. Use the existing loading interfaces without changing RSI Runtime or CLI.

## Next discussion: evidence that the minimal run actually completed

Propose checking framework execution records from the fresh acceptance run, in addition to process completion. They should establish that the selected WorkBuddy task was actually evaluated and that the required minimal GEPA round completed normally. Old self-test results or a success message alone would not establish this.

This evidence rule is pending confirmation. It keeps the existing one-task, one-minimal-round scope: no new benchmark score threshold, improvement requirement, or detailed algorithm verification is proposed. Human review continues to assess algorithm logic.

## Verification

Documentation-only change. Checked prior acceptance requirements and existing public fact/measurement access interfaces, and verified local links and text formatting. No source code, configuration, or dependency was changed. No tests, model requests, or experiments were run.
