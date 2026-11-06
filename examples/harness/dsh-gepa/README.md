# DSH GEPA

This example optimizes the Office discipline prompt with GEPA v2. The
[Recipe](recipe.yaml) uses the [baseline Office Bundle](baseline/) and its narrow
[Target](target.yaml). The algorithm source is
[`src/plugins/gepa/`](../../../src/plugins/gepa/) and its orchestration Policy is
[`src/policies/gepa/policy.yaml`](../../../src/policies/gepa/policy.yaml).

## Running

Prepare Node 24, install the project dependencies, and configure the Evaluator's
WorkBuddy Office execution environment. Run the following commands from the
repository root.

Configure `MODEL_ENDPOINT`, `MODEL_API_KEY`, `GEPA_WORKBUDDY_SOURCE` and
`GEPA_WORKBUDDY_CACHE` in the execution environment. The model name is a proxy
alias; inspect its upstream route before running a real evaluation. The example
contains the Office Bundle and its narrow Target; the WorkBuddy dataset remains
an external local source.

```sh
pnpm build
pnpm ember-rsi validate examples/harness/dsh-gepa/recipe.yaml
pnpm ember-rsi run examples/harness/dsh-gepa/recipe.yaml --id gepa-office
```

The built-in startup entrypoint provides `gepa.optimizer` and `policy.gepa`.
Run facts, candidates, measurements and receipts are stored in `.rsi/`.

## Algorithm shape

- `initialize` measures the initial candidate on the sampled selection set and
  records per-instance observed scores, ancestry and a seeded RNG state.
- Each Policy loop iteration is one logical attempt. `completedRounds` counts
  only attempts where a proposal was committed as a candidate and evaluated;
  no-change and failed proposal attempts are recorded in `rounds` without
  inflating that count. The loop's `maxRounds` and the plugin's round-limit
  check both stop before a further proposal or evaluation.
- Mutation samples a parent from the instance-wise Pareto frontier after
  removing dominated candidates, weighted by instance-leading frequency. It
  rotates one module cursor, evaluates the parent on the feedback minibatch,
  sends the current prompt plus task inputs, observable outputs, execution
  files and evaluator feedback to the reflective Agent, records a candidate,
  evaluates it on the same minibatch, and admits only a strict mean
  improvement. Admitted candidates are then scored on selection data.
- `crossoverEvery` controls when the System-aware Merge path is attempted.
  Crossover samples candidates from the whole accepted population (not the
  instance-winner sampling pool), checks direct/transitive ancestry, repeated
  merge keys, ancestor aggregate eligibility and module desirability, then
  combines modules by the Appendix D.1 rules. It compares the merged candidate
  with both genetic source parents on the same minibatch. The Application
  workspace base is the common ancestor, while the optimizer state separately
  records both genetic parents and their inherited lineage.
- Crossover does not advance the mutation module cursor. A fallback mutation
  still advances it exactly once.
- `maxRollouts` bounds task evaluation attempts. Initial selection is truncated
  to the remaining allowance. Before starting a later attempt, the plugin
  reserves its worst-case cost: `2b + n` task rollouts for mutation or `3b + n`
  for crossover, where `b` is the feedback minibatch size and `n` is the fixed
  selection-set size. Reused Manager receipts and reused measurements are reported as
  reused and do not consume rollouts, while a measured zero remains a valid
  score and an unavailable/failed/unknown result stays unknown.

Only complete finite selection vectors participate in parent sampling or final
selection. Candidate identities appear once in the population. Both comparison
and selection scoring require matching measurement conditions, task conditions
and scalar metric definitions. A cancelled evaluation propagates cancellation;
an unavailable or incompatible evaluation does not count as a completed round.

The seeded sampler (mulberry32) and its state are stored in the Policy state.
Identical inputs and seed reproduce the random choices; reproducing the complete
candidate sequence also requires identical Agent and Evaluator results, including
the same receipt-replay behavior. A seed does not make live model output
deterministic.

## Single-task integration

The Office example Recipe uses
`workbuddy/board-material-update-timeline-excel` for both feedback and
selection. `datasetDegenerate` in the output is `true` for this integration.
That is an explicit single-task degeneracy; the optimizer still keeps the two
sets separate in state and uses the general multi-instance code path. General
multi-instance behavior is exercised by the local deterministic tests.

## Evidence and limits

The reflective request receives authorized execution-view files
(`readEvidence(..., { format: 'files', view: 'execution' })`) and evaluator
feedback. It does not receive private verifier files or hidden grading answers.
The example opts into the SDK's `includeTaskAnswer` recording option to retain
the public task prompt. The evaluator adapter publishes only that prompt as an
initial execution event; any reference answer remains in private native records.
The provided Recipe sets `reflectionMaxModelCalls: 12` per reflective session,
separately from the Recipe-wide `modelCalls: 128` budget, so evidence reads and
the final JSON response fit the same bounded session. The Office target edits
only `plugins/office-base/prompts/office-discipline.md`; model weights and all
other Bundle files are unchanged.
