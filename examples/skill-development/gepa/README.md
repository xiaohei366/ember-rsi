# Skill-guided GEPA development

This example prepares the fixed inputs for `policy.skill-development`. It optimizes the general ember-rsi development skill by evaluating fresh GEPA implementations, then requires independent execution and human logic review. Preparing files, validating a Recipe and passing controlled tests do not establish real DSH development, WorkBuddy acceptance, algorithm correctness or skill improvement.

The extension is opt-in. Build the repository normally with `pnpm build`, then load `dist/src/extensions/skill-development` with the existing `--plugin-dir` option. Runtime and CLI registration remain unchanged.

## Prepare the environment

Provide a local GEPA **v2** PDF from [the paper](https://arxiv.org/abs/2507.19457v2), a verified Office AgentBundle containing `plugins/office-base/prompts/office-discipline.md`, and an immutable, already available Linux development image identified as `NAME@sha256:DIGEST`. Do not include an external GEPA implementation or implementation-derived material in the image, paper package or task materials.

The image must already contain Node 24, `pnpm@11.22.0`, bash, standard filesystem utilities and the exact frozen repository's installed dependencies at `/opt/ember-rsi-deps/node_modules`. Save that dependency installation's `pnpm-lock.yaml` at `/opt/ember-rsi-deps/pnpm-lock.yaml`. Preparing this image is an explicit prerequisite; the helper does not build it, install dependencies or download files. The helper checks its local availability and Node/pnpm/lockfile identity with networking disabled. This check does not run the complete build or prove the image has no hidden external material.

For a locally built image, retain its tag as well as its digest, for example `local-development:prepared@sha256:DIGEST`, and verify that Docker BuildKit can use that reference without a registry pull. The task uses `/usr/local/bin/pnpm` to avoid a harness-supplied pnpm shadowing the prepared version, and disables pnpm's automatic dependency reinstall when running scripts in a fresh workspace. Verify the image against a fresh source copy with networking disabled before starting an experiment.

Run from the repository root, replacing the three explicit input paths:

```powershell
$Prepared = node scripts/prepare-gepa-development.mjs `
  --image 'registry.example/development@sha256:REPLACE_WITH_64_HEX_DIGEST' `
  --paper 'GEPA-v2.pdf' `
  --office-bundle 'PATH_TO_VERIFIED_OFFICE_BUNDLE' | ConvertFrom-Json
```

Optional `--revision`, `--skill`, `--repository` and `--output` select the frozen commit, initial skill and output location. Output must be a **new** directory below the selected repository's `.rsi/`. Existing files are never reused. Failure may leave an incomplete directory; only a final `prepared.json` identifies completed input preparation. Review the PDF's version yourself; the manifest records the operator-supplied file's hash, not independent paper authentication.

Use `--model` when the provider exposes V4.1 Flash under a different identifier, for example `--model deepseek-v4.1-flash`. The helper freezes that identifier for all four roles and the development requirements before the experiment starts.

The helper archives the selected Git commit, omits its `skills/ember-rsi` tree, and adds fixed Office inputs under `.gepa/input/`. The manifest records these transformations and file hashes. It copies the same prepared baseline into a local Harbor task, creates a pristine development Bundle template, and creates a separate skill candidate Bundle containing the exact initial skill and fixed assets. This supplies one authoritative skill version per attempt. It leaves the repository and installed everyday skill untouched.

The candidate stores editable guidance at `skills/ember-rsi`. Before execution, the Evaluator supplies that selected version under `plugins/development/skills/ember-rsi` in a fresh development Bundle and includes the complete skill entry in its startup prompt. DSH copies the plugin subtree into its profile; the plugin identifies the installed skill directory so references and fixed assets remain available there. The runtime Bundle does not carry a second root-level skill copy.

## Validate and run

Configure `MODEL_ENDPOINT` and `MODEL_API_KEY` locally. The endpoint must be reachable through the Evaluator's Docker model gateway; no credentials are stored in the prepared Recipe. All four roles initially use `ds-v4.1-flash`; keep their parameters fixed across rounds. Real WorkBuddy preflight and independent acceptance need their own prepared runtime, dataset and network access. The Harbor development task declares `agent.network_mode = "no-network"`, which the pinned Evaluator projects to its model-only gateway. Ordinary web access and dependency downloads remain unavailable during coding.

```powershell
node dist/src/entries/cli/main.js validate $Prepared.recipe --plugin-dir $Prepared.pluginDirectory
node dist/src/entries/cli/main.js run $Prepared.recipe --plugin-dir $Prepared.pluginDirectory
```

The outer Policy preflights the fixed WorkBuddy task before coding. Each attempt gets a new checkout and session, runs local self-tests, exports its source, and enters a fresh acceptance process. The delivery entry points are `.gepa/recipe.yaml` and `.gepa/extension/index.mjs`; only the Office discipline prompt is mutable in the inner experiment. The prepared original requirements and manual algorithm checklist are under the task's `environment/materials/`; they are fixed before each attempt. The one-task run may reuse that task for feedback and selection, which limits the evidence; deterministic multi-instance tests still cover general algorithm behavior.

Initial limits are 10 development attempts, 60 minutes per development execution, 4 hours per independent acceptance, 24 hours per human wait, and 72 hours overall. Change explicit configuration before starting when necessary. Stage transitions and environmental retries do not reset consumed rounds or the overall clock. A no-change proposal requests human input. Timeouts, stopped runs and exhausted limits remain unfinished even if the Runtime returns normally.

## Human review and retained results

When review material is ready, the live process prints a unique request directory. Use the plugin-owned command to inspect its saved report, context and request identifiers:

```powershell
node dist/src/plugins/human-review/feedback.js show 'REQUEST_DIRECTORY'
node dist/src/plugins/human-review/feedback.js submit 'REQUEST_DIRECTORY' 'FEEDBACK.json'
```

Create `FEEDBACK.json` using the exact `requestId`, `attemptId` and `candidateRef` returned under `request` by `show`. For example, an implementation review can continue with an unmet original requirement:

```json
{
  "requestId": "COPY_REQUEST_ID_FROM_SHOW",
  "attemptId": "COPY_ATTEMPT_ID_FROM_SHOW",
  "candidateRef": "COPY_CANDIDATE_REF_FROM_SHOW",
  "action": "continue",
  "issues": [
    "The implementation does not yet enforce the original rollout budget."
  ],
  "explanation": "Address this original requirement using the retained execution evidence."
}
```

Replace the example issue with an observed issue from the actual review. Select an action permitted by the request's context:

| Context          | Permitted actions                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `implementation` | `accept` after automatic success; `continue` with original-requirement issues; `stop`.                                                             |
| `failure`        | `development-problem` with issues and a diagnosis; `retry` after confirmed environmental repair; `environment-unrepaired` to keep waiting; `stop`. |
| `no-change`      | `continue` with original-requirement issues for another proposal; `stop`.                                                                          |

For `retry`, the explanation must state what was repaired and confirm readiness for another attempt with the same skill. An environmental diagnosis alone does not trigger a retry. `environment-unrepaired` requires an explanation and retains the active request and its original deadline; it neither extends the wait nor consumes a development attempt. After repair, submit `retry` with the same identifiers before that deadline. Silence is not approval. The initial version does not promise continuation after the RSI process exits.

The Evaluator retains reports, available traces, development-only known/unknown cost and source artifacts under `.rsi/`. After automatic success and human acceptance it exports the reviewed source/configuration together with the exact producing skill and fixed support. Applying that package to the repository or installed skill is a separate explicit action.
