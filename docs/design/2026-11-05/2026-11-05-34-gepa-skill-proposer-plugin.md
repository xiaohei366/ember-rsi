# GEPA skill optimization: reuse-based Proposer plugin

Date: 2026-11-05

Status: Decision 62 confirmed; skill Proposer implementation remains pending.

This confirms the Proposer integration proposal in the [result-package decision](2026-11-05-33-gepa-result-package.md). Existing requirements for [historical skill bases](2026-11-05-07-gepa-historical-skill-bases.md) and [summary-first evidence access](2026-11-05-09-gepa-proposer-history-access.md) remain in force.

## Decision 62: add a skill-focused Proposer using existing editing capabilities

Add a dedicated skill Proposer plugin that reuses existing file-reading, bounded editing, and Application candidate-commit capabilities. Its business logic supplies the agreed development cost, quality, and human feedback, supports on-demand development-trace access, and selects an authorized historical skill version as the base for modification.

Record the actual selected parent and the reason for choosing it. Apply the existing INV-inspired diagnosis process and restrict changes to the skill entry and reference Markdown. Keep example/configuration assets fixed. The plugin's selected model, no-change behavior, and comparison priorities remain as previously agreed.

This is a business-plugin adaptation, not a replacement editing engine. Keep RSI Runtime and CLI unchanged, and preserve other Proposer users' existing behavior.

## Next discussion: validate a skill proposal before development

Propose a quick local check before starting development with a proposed skill: enforce allowed edit paths, verify that the skill entry can be loaded, and check that local document references resolve to available files. Reuse existing scope and skill-format checks where applicable; supplement only missing checks for this workload.

The [Application already checks skill metadata and body format](../../../src/plugins/application-agentbundle/skills.ts), and [candidate commit enforces Target boundaries](../../../src/plugins/shared/file-application/files.ts). These mechanisms do not by themselves check local Markdown references or establish an automatic repair workflow.

Propose returning failed checks to the Proposer for at most one automatic correction; if the correction still fails, request human input. Do not start a development attempt with an invalid proposal. Since development has not started, this correction does not consume a development round, and its usage remains Proposer work. The checks and correction policy remain pending confirmation.

## Verification

Documentation-only change. Inspected current Application skill validation, candidate commit, and shared edit validation; checked local links and text formatting. No source code, configuration, or dependency was changed. No tests, model requests, or experiments were run.
