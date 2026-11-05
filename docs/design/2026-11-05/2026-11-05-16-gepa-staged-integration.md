# Staged validation before real DSH and WorkBuddy execution

Date: 2026-11-05

Status: Confirmed design decision; not implemented.

This continues the [acceptance model choices](2026-11-05-15-gepa-acceptance-models.md) and defines the implementation and validation order for the agreed experiment. Earlier decisions remain in effect.

## Confirmed decision 46: Validate orchestration with simulated results before real integration

First, connect the outer RSI loop and the plugin-owned human feedback mechanism using simulated development and acceptance results. Exercise the actual loop and review handling with those controlled results, including continuation, acceptance, stopping, and timeout behavior, before making real model calls for the experiment.

Use this stage to verify orchestration and its observable outcomes. Keep the Runtime and RSI CLI unchanged. Simulation does not establish DSH compatibility, WorkBuddy availability, GEPA correctness, real cost capture, or skill improvement.

After the simulated workflow passes, connect the real DSH development Agent and WorkBuddy evaluation path. Run the agreed [environment preflight](2026-11-05-04-gepa-environment-preflight.md) before starting the real skill optimization experiment. A successful simulation does not replace that preflight or the fresh-process acceptance runs.

Keep simulated validation results separate from real development attempts. They do not consume the real experiment's ten-round allowance or count as measured development results.

## Verification status

This document records the agreed implementation order only. No simulated workflow, real integration, preflight, model call, or experiment was executed. Documentation formatting and local links were checked.
