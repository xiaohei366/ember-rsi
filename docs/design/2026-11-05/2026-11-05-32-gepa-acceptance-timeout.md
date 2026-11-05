# GEPA skill optimization: independent acceptance timeout

Date: 2026-11-05

Status: Decision 60 confirmed; timeout configuration and enforcement remain to be implemented.

This confirms the timeout proposal in the [development self-test decision](2026-11-05-31-gepa-development-self-tests.md) and supplements the [overall experiment time limit](2026-11-05-18-gepa-overall-time-limit.md).

## Decision 60: allow four hours per independent acceptance execution

Expose a configurable limit for each independent formal acceptance execution and set it to four hours (14,400,000 milliseconds) for the first version. Apply it when the Evaluator launches its acceptance runner using the delivered implementation. It is separate from the 60-minute development limit and the human-review waiting limit.

The remaining overall 72-hour budget continues to bound acceptance. Entering acceptance does not reset the experiment clock or guarantee a full four hours when less overall time remains. This limit applies to independent acceptance; it does not change the preflight workload or authorize more development rounds.

When acceptance times out, stop the owned execution through cancellation and cleanup, retain available records and artifacts, and record that acceptance did not complete. Apply the existing distinction between development problems and environmental faults; uncertain causes go to the user through the agreed failure-review mechanism. Timeout is not evidence of either cause by itself.

Acceptance remains excluded from the development cost returned to the Proposer. Implement this stage limit in the development Evaluator's execution handling using existing cancellation facilities, without changing RSI Runtime or CLI.

## Next discussion: deliver the accepted implementation and skill together

Propose exporting a result package under the experiment's `.rsi/` output area after acceptance and human approval. It would contain the reviewed GEPA source and run configuration, the exact skill version used to produce it, and a short result summary linking to the associated evidence.

The proposed first version exports this package without automatically overwriting the working repository or installed skill. Applying the accepted result to those locations would be a subsequent explicit action. This delivery choice is pending confirmation; retaining the accepted implementation/skill pair is already required by the [human-review decisions](2026-11-05-11-gepa-human-review-decisions.md).

## Verification

Documentation-only change. Checked existing timeout, cost, and result-retention decisions and public artifact capture/materialization interfaces; checked local links and text formatting. No source code, configuration, or dependency was changed. No tests, model requests, or experiments were run.
