# GEPA skill optimization: prepared materials and development network

Date: 2026-11-05

Status: Decision 55 confirmed; development environment configuration remains pending.

This confirms the network proposal in the [failure-review actions record](2026-11-05-26-gepa-failure-review-actions.md). It implements the intended reference boundary from [decision 31](2026-11-05-gepa-skill-optimization.md) within the [local task package approach](2026-11-05-23-gepa-local-development-task.md).

## Decision 55: prepare inputs before development and allow only model access

For the first version, prepare the fixed GEPA paper, RSI repository baseline, skill resources, and required development dependencies before starting a development attempt. The current skill candidate still comes through the AgentBundle rather than a frozen copy embedded in the task package.

During the development phase, permit network access only to the configured model endpoint. The Agent cannot browse external websites or download additional dependencies while coding, self-testing, or repairing its implementation. Required development materials must be available locally.

Reuse the existing Evaluator network facilities for this restriction. Preparation and independent WorkBuddy acceptance retain their separate environment and network requirements. This decision does not change RSI Runtime or CLI, the fixed-baseline/fresh-session rule, or the development-only cost definition.

Prepared reference material must still respect the paper-only GEPA rule; preparing materials in advance does not authorize including external GEPA implementations or implementation-derived explanations.

## Next discussion: deliver the current skill reliably

Propose supplying the current candidate's `SKILL.md` content at Agent startup, with its reference documents and fixed assets available for on-demand reads. Expose one authoritative skill version for the attempt and prevent a stale repository copy from being selected instead. Keep this loading method fixed across rounds and retain evidence identifying the delivered version.

This loading choice remains pending confirmation. It is meant to evaluate how the skill guides development; supplying its content is not proof that the Agent followed every instruction. The existing Office Bundle demonstrates startup prompt assembly, but the development Bundle and actual skill delivery still require implementation and verification.

## Verification

Documentation-only change. Checked prior decisions and the existing Office Bundle's prompt assembly, and verified local links and text formatting. No code, dependency, task configuration, or network setting was changed. No tests, model requests, or experiments were run.
