# GEPA skill optimization: evidence for minimal-run acceptance

Date: 2026-11-05

Status: Decision 58 confirmed; acceptance checks remain to be implemented.

This confirms the evidence proposal in the [fixed acceptance startup decision](2026-11-05-29-gepa-fixed-acceptance-entry.md). It specifies how to verify the existing [one-task, one-minimal-round acceptance scope](2026-11-05-02-gepa-workbuddy-acceptance.md).

## Decision 58: verify the completed workload through framework records

Formal acceptance checks records produced by the fresh acceptance run to establish both that the selected WorkBuddy task actually executed and produced an evaluation result, and that the required minimal GEPA round completed normally.

A process that merely starts or exits without an error, a success message, or records left by earlier self-tests do not establish this workload completion. Tie the inspected records to the current acceptance run and delivered implementation.

Keep acceptance lightweight. No benchmark score threshold, demonstrated score improvement, full benchmark campaign, or detailed automatic algorithm test is required. Human review continues to assess algorithm logic and the main implementation requirements. Development defects, environmental faults, and uncertain failures follow their existing feedback routes.

## Next discussion: development self-test scope

Propose limiting first-version development self-tests to locally runnable build/type checks, unit tests, registration/configuration checks, and controlled simulations. Real WorkBuddy execution would occur in the already agreed preflight and independent acceptance stages.

This would reduce the integration needed to launch a second evaluation environment from inside the development task. The existing Harbor task environment does not expose a Docker daemon socket to the Solver. The tradeoff is that some real integration failures may first appear in formal acceptance.

This narrower self-test scope is a proposal, not a confirmed restriction. Existing permission for development self-tests and repairs remains in force until this choice is settled. Their cost remains development cost; independent acceptance remains excluded.

## Verification

Documentation-only change. Checked prior self-test, cost, and acceptance decisions and the Evaluator's Harbor environment documentation; checked local links and text formatting. No source code, configuration, or dependency was changed. No tests, model requests, or experiments were run.
