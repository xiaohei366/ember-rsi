# GEPA skill optimization: first-version development self-tests

Date: 2026-11-05

Status: Decision 59 confirmed; development environment and test setup remain pending.

This confirms the self-test proposal in the [minimal-run evidence decision](2026-11-05-30-gepa-minimal-run-evidence.md). It narrows the first version's development self-tests while retaining the existing coding, testing, and repair workflow.

## Decision 59: use local checks and simulations during development

The development Agent may build and type-check its implementation, write and run unit tests, check plugin registration and configuration loading, and perform controlled local simulations. It may inspect failures and repair its code within the existing development limit.

Do not run real WorkBuddy evaluations from inside the first-version development task. Real WorkBuddy execution belongs to the already agreed environment preflight and independent formal acceptance stages. This avoids adding a nested evaluation environment to the development container; some real integration issues may therefore first appear during acceptance.

Self-tests remain part of development cost. Independent acceptance remains outside that cost and the development timeout. A passing simulation does not substitute for [formal acceptance using actual framework records](2026-11-05-30-gepa-minimal-run-evidence.md), and formal acceptance findings continue through the established failure/feedback routes.

This decision specializes earlier descriptions that allowed self-tests to call the same WorkBuddy services as acceptance. It does not change the general rule that costs are classified by execution stage.

## Next discussion: independent acceptance timeout

Propose a separate configurable time limit for each independent acceptance execution, initially four hours. The [current Harness² WorkBuddy configuration](../../../examples/harness/dsh-harness2/recipe.yaml) uses `run.timeoutSeconds: 4500` (75 minutes), and the agreed minimal GEPA round may evaluate the same task more than once. The development limit therefore should not be reused as the acceptance limit.

Four hours is a proposed ceiling, not a measured duration or a guarantee that all allowed task executions fit. The existing overall 72-hour budget still takes precedence. On acceptance timeout, stop owned execution, preserve available results, and apply the existing failure-attribution rules; an uncertain cause goes to human review.

This acceptance limit remains pending user confirmation. No new Runtime timing capability is proposed.

## Verification

Documentation-only change. Checked existing time-limit decisions and the current WorkBuddy example configuration, and checked local links and text formatting. No source code, dependency, environment, or experiment configuration was changed. No tests, model requests, or experiments were run.
