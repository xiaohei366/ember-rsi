# GEPA skill optimization: reuse the existing Evaluator

Date: 2026-11-05

Status: Reuse direction confirmed; SDK component simulation passed; production workload integration remains pending.

This supplements the [consolidated design and interface audit](2026-11-05-20-gepa-consolidated-design-and-audit.md). It resolves that audit's inability to inspect the Evaluator SDK and narrows the proposed development Evaluator to task preparation and business integration around the existing engine. Decisions 1–49 remain unchanged.

## Decision 50: reuse before extending

The user supplied the local ember-evaluator repository and requested adapting it instead of building a replacement. Reuse its existing DSH AgentBundle execution, task environments, artifact collection, result persistence, and usage accounting. Add capabilities only when a concrete integration gap is demonstrated.

The outer RSI development Evaluator still owns development-task preparation, independent acceptance, cost/quality feedback, and review material. It delegates execution to ember-evaluator. The outer Policy and human-review plugin retain their agreed responsibilities. RSI Runtime and CLI remain unchanged.

## Source findings

Inspected RSI revision `838e679e57fb0617655ac1528c778f8a8b672643` and Evaluator revision `034a7da3acd7c6311d4a7dfb5c037e523a172fbd`.

| Need | Existing Evaluator support | Integration implication |
| --- | --- | --- |
| Run the development Agent | [AgentBundle Solver](https://github.com/evolving-foundry/ember-evaluator/blob/034a7da3acd7c6311d4a7dfb5c037e523a172fbd/src/plugins/solvers/agentbundle.ts) prepares and executes DSH. | Supply the fixed development Bundle and selected skill; reuse Solver execution. |
| Supply a repository task | [Task contract](https://github.com/evolving-foundry/ember-evaluator/blob/034a7da3acd7c6311d4a7dfb5c037e523a172fbd/src/core/contracts/task.ts) supports initial environments, collection, and phase limits. The built-in [Harbor task adapter](https://github.com/evolving-foundry/ember-evaluator/blob/034a7da3acd7c6311d4a7dfb5c037e523a172fbd/src/plugins/benchmarks/protocols/harbor/task.ts) supports local task packages and declared artifacts. | First try packaging the fixed RSI checkout, paper-only task brief, and delivery paths as a local task. A new execution engine is unnecessary. |
| Retain generated code and traces | [Attempt execution](https://github.com/evolving-foundry/ember-evaluator/blob/034a7da3acd7c6311d4a7dfb5c037e523a172fbd/src/core/run-task.ts) collects declared artifacts and attempts collection during failure cleanup. | Capture delivery and evidence before workspace release. Missing or partial collection remains explicit. |
| Report development usage | [Attempt accounting](https://github.com/evolving-foundry/ember-evaluator/blob/034a7da3acd7c6311d4a7dfb5c037e523a172fbd/src/core/attempt-accounting.ts) reads persisted usage, preserves a valid prefix after failure, and leaves unavailable amounts null. | Consume development-attempt accounting and coverage; do not use whole-experiment totals or assume missing values are zero. |
| Return failures for diagnosis | [SDK entrypoint](https://github.com/evolving-foundry/ember-evaluator/blob/034a7da3acd7c6311d4a7dfb5c037e523a172fbd/src/evaluator.ts) returns persisted task-level failures and carries available partial results in orchestration errors. | Classify results in the RSI business adapter before crossing its fatal call boundary. Do not globally suppress SDK errors or convert infrastructure faults into skill feedback. |

The RSI lockfile pins Evaluator commit `a585889ecbf6e33fc3900507e72712bade5201df`. It is available in the local Evaluator Git history. The inspected SDK entrypoint, DSH protocol, Harbor task adapter, attempt execution/accounting, and result contract have no diff between that pin and the inspected local HEAD. Other files differ, including environment/configuration-related code; this is not a claim of complete version equivalence. No dependency pin or package manifest was changed.

## Concrete simulation added

Two files were added to ember-evaluator:

- `tests/fixtures/repository-development/plugin.mjs`: a controlled development Benchmark/Solver loaded through the existing explicit SDK patch mechanism. It starts with a fixed tiny repository, changes one source file, emits synthetic usage, and declares repository artifacts.
- `tests/integration/repository-development.test.ts`: runs the real public `Evaluator.run`, local environment, collection, accounting, persistence, and cleanup. It checks successful development, failure after code creation, and unavailable usage. It extracts retained code and checks it in a separate Node process after SDK completion.

These are reusable integration tests, not a production development plugin or a GEPA implementation. They verify that SDK infrastructure can perform the required delivery/accounting handoff without changing its production code. The original repository fixture remains unchanged, undeclared scratch output is excluded, and failure feedback retains its failed status even when exported code passes the separate fixture check.

The controlled Benchmark bypasses Harbor packaging, and the controlled Solver replaces DSH and model calls. The tests do not establish real DSH skill loading, Docker setup, nested self-tests, formal GEPA acceptance, human-review orchestration, or WorkBuddy execution.

## Remaining integration work

Package the fixed development workload and try the existing local Harbor path first. Keep delivery checks separate from formal acceptance: the latter still runs the delivered GEPA implementation in a fresh process with the agreed WorkBuddy task. If task packaging is insufficient, add a small Benchmark adapter through existing plugin interfaces rather than changing the generic engine.

The RSI-side adapter must preserve artifact references, normalize development-only usage, distinguish development problems from environmental faults, and prepare review material. Its current Agentbench adapter throws on relevant nonzero SDK exit codes, so reusing it unchanged would terminate the outer loop instead of supplying development feedback.

Real integration must still verify fresh DSH sessions, actual use of the skill candidate, allowed repository writes, usable development/self-test dependencies, delivery capture, and independent acceptance. Model-call counts and any nested self-test model usage require attributable evidence; token accounting in the controlled fixture does not establish those measurements.

This SDK component simulation is a preparatory check. It does not replace the agreed simulation of the actual outer Policy, Proposer, and human-review components before real DSH/WorkBuddy integration.

## Actual verification

- `pnpm install --frozen-lockfile` completed in ember-evaluator; its existing prepare/build lifecycle passed. Dependency manifests and lockfiles stayed unchanged.
- The initial selected test run passed 56 existing tests across SDK lifecycle, local artifacts, Benchmark examples, attempt accounting, and DSH protocol. The three new tests initially exposed a missing `origin` field in the controlled source-lock fixture; the fixture was corrected.
- `pnpm test --run tests/integration/repository-development.test.ts` then passed all three new tests. The final combined run of the six selected files passed all 59 tests; this is not a full-suite result.
- `pnpm typecheck` passed after the final test edit. Checked UTF-8/LF formatting and final newlines for the three new files, all seven document link targets, repository status, and whitespace. Confirmed that production sources and dependency manifests/lockfiles remain unchanged.
- No production Evaluator code, RSI source, Runtime, CLI, or dependency pin was changed. No real model, DSH development session, GEPA experiment, or WorkBuddy task was run.
