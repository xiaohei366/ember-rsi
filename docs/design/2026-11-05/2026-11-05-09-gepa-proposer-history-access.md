# Summary-first history access for the Proposer

Date: 2026-11-05

Status: Confirmed design decision; not implemented.

This continues the [quality-first comparison decision](2026-11-05-08-gepa-quality-first-selection.md) and supplements the INV-inspired evidence use in decision 24 of the [main continuation](2026-11-05-gepa-skill-optimization.md). Earlier decisions remain in effect.

## Confirmed decision 39: Supply round summaries and on-demand development traces

At each proposal step, provide concise summaries of the development rounds available so far. Identify each round and its skill version, execution and acceptance results, human-reported issues, and development cost. Keep missing results and unavailable usage explicit.

Provide read access to the available detailed development traces through references associated with those rounds. The Proposer first uses the summaries to locate relevant attempts, then reads the related tool calls, results, errors, and self-tests to investigate the issue before editing the skill.

Do not insert all historical raw logs into every proposal prompt. Summary-first delivery changes how evidence is accessed, not the requirement to ground a proposed change in relevant evidence. Preserve trace omissions or truncation information rather than implying that a summary or partial trace is a complete record.

This history remains available to the Proposer for diagnosis and selection of a historical skill base. It does not enter the next development Agent's fresh session as prior development history. The existing feedback and acceptance inputs for that session remain unchanged.

## Verification status

This document records the agreed evidence-delivery design only. History summaries, trace access, and proposal behavior remain to be implemented and verified. No implementation, model call, or experiment was performed. Documentation formatting and local links were checked.
