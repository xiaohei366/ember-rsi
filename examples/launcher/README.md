# Guided example launcher

English | [简体中文](README_zh.md)

Launch **DSH Harness²** and **DSH WikiSkill** from a source checkout with grouped terminal prompts. Each example keeps `launch.yaml` beside its `recipe.yaml`; the Recipe supplies all defaults. The launcher uses the built public CLI and the dashboard's read-only observation API. It does not change framework state directly.

## Start

Use Node 24 and the repository's pnpm version. From the checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
node examples/launcher/launch.mjs
```

Choose an example, edit common parameters, optionally customize advanced parameters, and review the configuration. The actions are **Start experiment**, **Generate and validate only**, **Edit parameters**, and **Save answers and exit**. Saving answers alone does not generate a Recipe or run doctor.

Harness² requires `MODEL_NAME`, `EVALUATOR_MODEL_NAME`, `MODEL_ENDPOINT`, and `MODEL_API_KEY`. WikiSkill uses `MODEL_NAME` for both optimization and evaluation and requires `MODEL_ENDPOINT` and `MODEL_API_KEY`. An interactive run asks for missing values, masking secrets. Values entered here are passed only through child-process environment variables. Neither answers nor generated Recipes contain these environment values; `${VAR}` references remain intact. Nothing is written to `.env` files.

Time questions use hours or minutes and convert to the Recipe's milliseconds or seconds. Task lists accept commas, newlines, `[]` for an optional empty split, or `@path/to/tasks.txt`. Files may contain plain IDs separated by whitespace/commas or a YAML/JSON array. File paths entered with `@` resolve against the shell's working directory. WikiSkill's training, validation and test lists must be disjoint. Harness²'s displayed evaluation count is `4 × k × task count`, before retries or early termination.

## Generate, replay, resume and summarize

```sh
# Interactive configuration without starting an experiment
node examples/launcher/launch.mjs --dry-run

# Replay saved overrides without prompts; choose a fresh ID
node examples/launcher/launch.mjs --answers .rsi/launcher/<id>/answers.yaml --id <new-id>

# Generate and check without model credentials or real evaluations
node examples/launcher/launch.mjs --answers answers.yaml --dry-run

# Resume using the exact previously generated Recipe path
node examples/launcher/launch.mjs resume <id>

# Refresh a running or finished experiment's summary
node examples/launcher/launch.mjs summary <id>
```

An answers file contains only the template name and overrides in **display units**. For example:

```yaml
schemaVersion: rsi.launch.answers/v1
template: harness2
values:
  k: 2
  wall: 4
  evalTimeout: 30
  memory: false
```

The other template is `wikiskill`; its common keys are `trainTasks`, `validationTasks`, `testTasks`, `rounds`, `concurrency`, and `wall`. See the adjacent [Harness² manifest](../harness/dsh-harness2/launch.yaml) and [WikiSkill manifest](../harness/dsh-wikiskill/launch.yaml) for all keys and units. Unknown keys, invalid values, duplicate task IDs and missing manifest paths are rejected. Replay applies overrides to the **current** source Recipe defaults; it is not a frozen experiment snapshot. `resume` instead retains the saved Recipe and lets Runtime enforce its recovery rules. It requires an experiment already created by `run`; a dry-run alone cannot be resumed.

`--answers` never prompts, including for missing environment variables. Set them in the shell before starting a real run. Static-only generation reports missing variables without requiring them. IDs are generated automatically with a UTC timestamp and random suffix unless `--id` is supplied. Existing launcher directories are never overwritten by generation.

## Validation and artifacts

The launcher always writes under this checkout's `.rsi/launcher/<id>/` and launches the CLI from the checkout so the CLI and dashboard share one store:

| File           | Contents                                                       |
| -------------- | -------------------------------------------------------------- |
| `answers.yaml` | Template and values different from the current Recipe defaults |
| `recipe.yaml`  | Full generated Recipe with resource paths relocated            |
| `doctor.json`  | Full automatic static report; refreshed on resume              |
| `run.log`      | CLI stdout/stderr, appended on resume                          |
| `summary.md`   | Recorded status, usage, returned measurements and file changes |

Generation recursively rewrites string values beginning with `./` or `../` (also Windows backslash forms) to absolute paths based on the **original Recipe directory**. Bare candidate paths such as `plugins/...` and `tuning.json`, URLs and expressions retain their meaning. `${VAR}` references are not interpolated. Generated absolute paths are local to this checkout; replay the answers after moving it. Changes to a template's path conventions require checking that this rule still applies.

Every generated Recipe is automatically checked with `ember-rsi doctor <recipe> --static`; failures block launch and retain the report. There is no separate doctor action. Static checks establish configuration and declared path validity; they do **not** test model access, Docker, evaluator provisioning or real execution. Use the [full doctor command](../../docs/users/guides/doctor.md) separately when needed. `REPLACE_WITH_*` placeholders are rejected; generic placeholder/path prompts and inference/kernel search-space editing are outside this first version.

## Progress and results

A temporary dashboard binds to localhost on an available port. The launcher reads its observation API every 30 seconds for current usage and displays wall-clock budget consumption. This percentage describes budget use, not task completion. The current `show` command returns the saved experiment record, so it cannot supply live budget counters. The temporary dashboard is closed when monitoring or summary generation ends.

During monitoring, Ctrl+C offers **Keep watching**, **Cancel experiment and wait for cleanup**, or **Exit launcher; experiment keeps running**. In a noninteractive run it requests cancellation. Cancellation uses the public CLI; if the experiment has not yet created its record, the launcher reports that cancellation was not confirmed and keeps watching. The detached run process owns cleanup. After detaching, use `pnpm ember-rsi cancel <id>` to cancel or `summary <id>` to inspect it. A detached experiment does not automatically refresh the summary after completion.

The summary follows explicit Policy result references. It keeps validation and independent test measurements separate and does not select a winner from unrelated scores. A difference is shown only against a unique ancestor baseline with matching comparison key, metric definition and unit, and complete successful coverage. File comparisons use the public artifact digest listing; `?` means a digest is unavailable. Missing measurements or unavailable data remain unknown.

## Development checks

```sh
pnpm typecheck:examples
node --import tsx --test tests/unit/example-launcher.test.mjs
pnpm check
```

Launcher tests use local fixtures and simulated CLI processes. They do not run model calls or benchmarks. The `.mjs` entry imports TypeScript supported directly by Node 24; no launcher build is needed. `@clack/prompts` is a development dependency, and examples are excluded from release packages.
