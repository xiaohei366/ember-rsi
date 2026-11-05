# GEPA skill optimization: failure-review actions

Date: 2026-11-05

Status: Decision 54 confirmed; feedback command implementation remains pending.

This confirms the response proposal in the [uncertain-failure review decision](2026-11-05-25-gepa-uncertain-failure-review.md). It specializes feedback for failure diagnosis while retaining the [implementation-review decisions](2026-11-05-11-gepa-human-review-decisions.md).

## Decision 54: distinguish skill revision from an environment-repair retry

The plugin-owned feedback command supports the following actions for an uncertain-failure review:

| Human response | Policy action |
| --- | --- |
| Development problem, with diagnostic feedback | Supply the judgment and evidence to the Proposer for skill optimization, then follow the agreed development loop. |
| Environment repaired; retry | Keep the same skill version and begin a fresh development attempt from the fixed repository baseline and a fresh Agent session. |
| Stop experiment | Retain available results and end unfinished. |

Identifying an environmental fault without confirming repair does not start another attempt. Continue waiting under the existing review deadline and overall budget; no feedback or elapsed waiting time implies permission to retry. The round and budget limits still apply, and a retry does not erase the failed attempt or reset accounting.

Bind feedback to the active review request and associated attempt. The review plugin receives and validates the response, and the outer Policy applies it. These diagnostic actions do not substitute for automatic acceptance or human approval of the implementation. Keep the command in the plugin; RSI Runtime and CLI remain unchanged.

## Next discussion: enforce the paper-only reference boundary

Propose preparing the paper, repository, skill resources, and development dependencies before the attempt, then limiting the development environment's network access to the model endpoint. This would prevent direct retrieval of external GEPA implementations during development and require development materials to be available locally.

This network choice is pending confirmation. It concerns the development phase; preparation and independent WorkBuddy acceptance have separate requirements. Existing Evaluator Harbor/Docker code exposes a model-only network mode, but its integration with this development task has not been verified.

## Verification

Documentation-only change. Checked prior feedback and budget decisions, inspected existing Evaluator network declarations and Harbor mapping, and checked local links and text formatting. No source, configuration, dependency, or network setting was changed. No tests, model requests, or experiments were run.
