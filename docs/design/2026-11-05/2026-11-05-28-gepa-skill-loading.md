# GEPA skill optimization: explicit skill loading

Date: 2026-11-05

Status: Decision 56 confirmed; development Bundle implementation remains pending.

This confirms the loading proposal in the [development network decision](2026-11-05-27-gepa-development-network.md) and specifies how the current skill is supplied through the [development AgentBundle](2026-11-05-23-gepa-local-development-task.md).

## Decision 56: provide the entry at startup and read supporting files on demand

At the start of each development attempt, provide the current candidate's `SKILL.md` content to the Agent. Make that candidate's reference documents and the fixed example/configuration assets available for on-demand reads.

Expose one authoritative skill version for the attempt and prevent a stale repository copy from being used instead. Keep the loading method fixed across rounds and record the actual supplied candidate/version with the attempt's evidence. The Proposer's editable scope remains the skill entry and reference Markdown; supporting assets remain fixed.

This establishes which instructions are supplied, not that the Agent follows every instruction. Real integration still needs evidence of delivery to a fresh DSH session and observed development behavior. Reuse the existing AgentBundle execution path without changing RSI Runtime or CLI.

## Next discussion: a predictable acceptance entry

Propose requiring a runnable Recipe and plugin-loading entry at predefined delivery locations. The Evaluator's own acceptance runner would load these explicit inputs in a fresh process, avoiding the need to infer startup commands from free-form development output.

This delivery convention is pending confirmation. It would constrain the startup interface, not dictate the GEPA algorithm's internal implementation or require an Agent-authored implementation index. Formal acceptance scripts and passing criteria remain owned by the outer experiment, as already agreed in the [fresh-process acceptance decision](2026-11-05-10-gepa-fresh-process-acceptance.md).

## Verification

Documentation-only change. Checked earlier delivery requirements, the existing CLI Recipe/plugin-directory interface, and the programmatic startup example. Checked local links and text formatting. No source code, configuration, or dependency was changed; no tests, model requests, or experiments were run.
