# GEPA skill optimization: accepted result package

Date: 2026-11-05

Status: Decision 61 confirmed; result export remains to be implemented.

This confirms the delivery proposal in the [acceptance timeout record](2026-11-05-32-gepa-acceptance-timeout.md) and specifies the retained implementation/skill pair required by the [human-review decisions](2026-11-05-11-gepa-human-review-decisions.md).

## Decision 61: export the accepted pair to a separate result directory

After formal acceptance and the user's approval, export a result package under the experiment's `.rsi/` output area containing:

- The reviewed GEPA implementation source and run configuration.
- The exact skill version used to produce that implementation, with its required fixed supporting material.
- A concise acceptance/result summary and navigation to the associated execution records.

Bind the exported implementation, skill, and evidence to the same accepted attempt. Do not substitute a later untested skill proposal or a different round's implementation.

The first version delivers this package to a separate result directory. It does not automatically overwrite the working repository or replace the installed everyday skill. Applying the result to those locations is a subsequent explicit operation. Existing retention of unfinished attempts and failures remains unchanged; retaining those artifacts does not label them accepted.

## Next discussion: reuse existing Proposer editing capabilities

Propose adding a skill-focused Proposer plugin that reuses existing file-reading, bounded editing, and Application commit capabilities. Its additional business logic would assemble the already agreed development cost/quality/human feedback and select an authorized historical skill base before editing.

The [current Proposer](../../../src/plugins/proposer-agent/service.ts) reads and commits against `input.parent`; its editing request does not itself select a different historical parent. The [shared editing helpers](../../../src/plugins/shared/agent-editing/index.ts) are reusable for this integration. A dedicated business plugin would preserve other Proposer users' existing behavior and avoid Runtime changes.

This plugin choice remains pending confirmation. Historical-base selection, summary-first evidence access, documentation-only edits, and INV-inspired diagnosis are already agreed requirements; this proposal concerns their implementation through existing capabilities.

## Verification

Documentation-only change. Checked prior history/feedback requirements and current Proposer/editing code; checked local links and text formatting. No source code, configuration, or dependency was changed. No tests, model requests, or experiments were run.
