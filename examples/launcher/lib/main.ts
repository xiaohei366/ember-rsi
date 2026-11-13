import * as ui from '@clack/prompts';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import {
  applyAnswers,
  defaults,
  environment,
  experimentDirectory,
  generate,
  loadTemplates,
  loadManifest,
  object,
  parseInput,
  readAnswers,
  readRecipe,
  type Answer,
  type Parameter,
  type Recipe,
  type Template,
} from './config.ts';
import {
  createCli,
  startRun,
  withDashboard,
  type Cli,
  type Exit,
} from './process.ts';
import {
  duration,
  elapsed,
  overview,
  saveSummary,
  usageText,
} from './summary.ts';

class Interrupted extends Error {}
function answer<T extends Answer>(value: T | symbol): T {
  if (typeof value === 'symbol') throw new Interrupted('Launcher cancelled');
  return value;
}
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const interactive = (): boolean =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY);
const display = (value: Answer): string =>
  Array.isArray(value)
    ? `${value.length} tasks (${value.slice(0, 2).join(', ')}${value.length > 2 ? ', …' : ''})`
    : String(value);

async function promptParameter(
  param: Parameter,
  value: Answer,
): Promise<Answer> {
  const label = `${param.label}${param.unit ? ` (${param.unit})` : ''}`;
  if (param.type === 'bool')
    return answer(
      await ui.confirm({ message: label, initialValue: value === true }),
    );
  if (param.type === 'enum')
    return answer(
      await ui.select({
        message: label,
        initialValue: value,
        options: param.options!.map((option) => ({ value: option })),
      }),
    );
  const prompt = param.type === 'list' ? ui.multiline : ui.text;
  const raw = answer<string>(
    await prompt({
      message: `${label}${param.type === 'list' ? ' (comma/newline separated, [] for none, or @file)' : ''}`,
      initialValue: Array.isArray(value) ? value.join('\n') : String(value),
      validate: async (input) => {
        try {
          await parseInput(param, input ?? '');
        } catch (error) {
          return message(error);
        }
      },
    }),
  );
  return parseInput(param, raw);
}

async function configure(
  template: Template,
  values: Record<string, Answer>,
): Promise<Record<string, Answer>> {
  const result = { ...values };
  for (const group of template.manifest.groups) {
    if (
      group.advanced &&
      !answer(
        await ui.confirm({
          message: `Customize ${group.title.toLowerCase()} parameters?`,
          initialValue: false,
        }),
      )
    )
      continue;
    ui.log.step(group.title);
    const prompts = Object.fromEntries(
      group.params.map((param) => [
        param.key,
        () => promptParameter(param, result[param.key]),
      ]),
    );
    Object.assign(result, await ui.group(prompts));
  }
  return result;
}

function showConfiguration(
  template: Template,
  values: Record<string, Answer>,
  id: string,
  env: NodeJS.ProcessEnv,
): void {
  const configured = applyAnswers(template, values);
  const lines = template.manifest.groups.flatMap((group) => [
    group.title,
    ...group.params.map(
      (param) =>
        `  ${param.label}: ${display(configured.values[param.key])}${param.unit ? ` ${param.unit}` : ''}`,
    ),
  ]);
  const estimate = template.manifest.estimate;
  if (estimate) {
    const count = estimate.parameters.reduce((total, key) => {
      const value = configured.values[key];
      return total * (Array.isArray(value) ? value.length : Number(value));
    }, estimate.factor);
    lines.push(
      `Estimated evaluation runs: ${count} (before retries or early termination)`,
    );
  }
  lines.push(
    'Environment',
    ...environment(template, configured.recipe).map(
      (entry) =>
        `  ${env[entry.name]?.trim() ? '✓' : '○ missing'} ${entry.name}`,
    ),
  );
  const original = defaults(template);
  lines.push(
    'Changes from Recipe defaults',
    ...Object.entries(configured.answers.values).map(
      ([key, value]) =>
        `  ${key}: ${display(original[key])} → ${display(value)}`,
    ),
  );
  if (!Object.keys(configured.answers.values).length) lines.push('  None');
  ui.note(lines.join('\n'), `${template.manifest.title} · ${id}`);
}

async function ensureEnvironment(
  template: Pick<Template, 'manifest'>,
  recipe: Recipe,
  cli: Cli,
  allowPrompts = interactive(),
): Promise<void> {
  const missing = environment(template, recipe).filter(
    (entry) => !cli.env[entry.name]?.trim(),
  );
  if (missing.length && !allowPrompts)
    throw new Error(
      `Set environment variables before running: ${missing.map((entry) => entry.name).join(', ')}`,
    );
  for (const entry of missing) {
    const prompt = entry.secret ? ui.password : ui.text;
    cli.env[entry.name] = answer<string>(
      await prompt({
        message: `${entry.label} (${entry.name}; this process only)`,
        validate: (value) =>
          value?.trim() ? undefined : 'A value is required',
      }),
    );
  }
}

export function doctorText(raw: unknown): { text: string; failed: number } {
  const report = object(raw, 'Doctor report'),
    summary = object(report.summary, 'Doctor summary');
  for (const key of ['passed', 'failed', 'unchecked'])
    if (
      typeof summary[key] !== 'number' ||
      !Number.isSafeInteger(summary[key]) ||
      summary[key] < 0
    )
      throw new Error('Invalid doctor summary');
  if (!Array.isArray(report.checks) || !Array.isArray(report.missingResources))
    throw new Error('Invalid doctor report');
  const lines = [
    `✓ Passed ${summary.passed} · ✕ Failed ${summary.failed} · ○ Unchecked ${summary.unchecked}`,
  ];
  for (const rawCheck of report.checks) {
    const check = object(rawCheck, 'Doctor check');
    if (check.status === 'failed')
      lines.push(`${check.id}: ${check.reason ?? 'failed'}`);
  }
  for (const rawResource of report.missingResources) {
    const resource = object(rawResource, 'Missing resource');
    lines.push(`Missing ${resource.field}: ${resource.reference}`);
  }
  lines.push(
    'Static checks only; model access, Docker and component probes were not run.',
  );
  return { text: lines.join('\n'), failed: Number(summary.failed) };
}

async function doctor(cli: Cli, directory: string): Promise<void> {
  const controller = new AbortController();
  const spin = ui.spinner({
    accessible: !interactive(),
    onCancel: () => controller.abort(),
  });
  spin.start('Validating generated Recipe with doctor --static');
  try {
    const result = await cli.call(
      ['doctor', join(directory, 'recipe.yaml'), '--static'],
      controller.signal,
    );
    let report: unknown;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Doctor did not return JSON: ${result.stderr}`);
    }
    await writeFile(
      join(directory, 'doctor.json'),
      JSON.stringify(report, null, 2) + '\n',
      { mode: 0o600 },
    );
    const rendered = doctorText(report);
    if (result.code || rendered.failed) {
      spin.error('Static validation failed');
      ui.note(rendered.text, 'Doctor');
      throw new Error(
        `Fix the configuration or resources; full report: ${join(directory, 'doctor.json')}`,
      );
    }
    spin.stop('Static validation passed');
    ui.note(rendered.text, 'Doctor');
  } catch (error) {
    spin.error('Static validation stopped');
    if (controller.signal.aborted)
      throw new Interrupted('Static validation cancelled');
    throw error;
  }
}

async function monitor(
  cli: Cli,
  base: string,
  directory: string,
  id: string,
  resume: boolean,
): Promise<Exit | null> {
  const { child, finished } = await startRun(cli, directory, id, resume);
  let result: Exit | undefined;
  let interrupted = false;
  let wake: (() => void) | undefined;
  void finished.then((exit) => {
    result = exit;
    wake?.();
  });
  const progress = ui.progress({
    max: 100,
    size: 24,
    indicator: 'timer',
    accessible: !interactive(),
    onCancel: () => {
      interrupted = true;
      wake?.();
    },
  });
  let percent = 0;
  progress.start(`Starting ${id}; log: ${join(directory, 'run.log')}`);
  try {
    while (!result) {
      if (interrupted) {
        interrupted = false;
        const promptController = new AbortController();
        void finished.then(() => promptController.abort());
        const choice = interactive()
          ? await ui.select({
              message: 'Experiment control',
              signal: promptController.signal,
              options: [
                { value: 'continue', label: 'Keep watching' },
                {
                  value: 'cancel',
                  label: 'Cancel experiment and wait for cleanup',
                },
                {
                  value: 'detach',
                  label: 'Exit launcher; experiment keeps running',
                },
              ],
            })
          : 'cancel';
        if (result) break;
        if (ui.isCancel(choice) || choice === 'detach') {
          ui.log.info(
            `Experiment continues in its own process. Log: ${join(directory, 'run.log')}\nCancel: pnpm ember-rsi cancel ${id}\nSummary: node examples/launcher/launch.mjs summary ${id}`,
          );
          return null;
        }
        if (choice === 'cancel') {
          const cancel = await cli.call(['cancel', id]);
          if (cancel.code)
            ui.log.warn(
              `Cancellation was not confirmed: ${cancel.stderr.trim()}. The experiment may still be initializing; keep watching and retry.`,
            );
          else
            ui.log.info(
              'Cancellation requested; waiting for the experiment process and cleanup.',
            );
        }
        progress.start(`Watching ${id}`);
      }
      try {
        const record = await overview(base, id);
        const used = elapsed(record.startedAt, record.finishedAt);
        const limit = record.limits.elapsedWallMs;
        const next =
          used !== null && limit
            ? Math.min(100, (used / limit) * 100)
            : percent;
        progress.advance(
          Math.max(0, next - percent),
          `${record.status} · wall ${duration(used)}/${limit ? duration(limit) : '—'} · ${usageText(record)}`,
        );
        percent = Math.max(percent, next);
      } catch (error) {
        progress.message(
          `Status unavailable: ${message(error)}; run.log continues recording`,
        );
      }
      if (result || interrupted) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, 30000);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
    }
    progress.clear();
    return result ?? null;
  } catch (error) {
    ui.log.warn(
      `Monitoring stopped; experiment ${id} may still be running. Inspect run.log or use pnpm ember-rsi cancel ${id}.`,
    );
    throw error;
  } finally {
    progress.clear();
    child.unref();
  }
}

async function run(
  cli: Cli,
  directory: string,
  id: string,
  resume: boolean,
): Promise<number> {
  const controller = new AbortController();
  const spin = ui.spinner({
    accessible: !interactive(),
    onCancel: () => controller.abort(),
  });
  spin.start('Opening local observation dashboard');
  try {
    return await withDashboard(
      cli,
      async (base) => {
        spin.stop('Observation dashboard ready');
        const exit = await monitor(cli, base, directory, id, resume);
        if (!exit) return 0;
        if (exit.error) throw exit.error;
        try {
          spin.start('Summarizing recorded results');
          const summary = await saveSummary(
            base,
            id,
            directory,
            controller.signal,
          );
          const record = await overview(base, id, controller.signal);
          spin.stop('Summary ready');
          ui.note(
            summary.length > 5000
              ? `${summary.slice(0, 5000)}\n… See the complete summary file.`
              : summary,
            'Experiment summary',
          );
          ui.outro(`Saved ${join(directory, 'summary.md')}`);
          return exit.code === 0 && record.status === 'succeeded'
            ? 0
            : record.status === 'cancelled'
              ? 130
              : 1;
        } catch (error) {
          if (controller.signal.aborted)
            throw new Interrupted(
              'Summary cancelled; experiment process has already exited',
            );
          spin.error('Summary unavailable');
          ui.log.error(
            `Summary unavailable: ${message(error)}. Inspect ${join(directory, 'run.log')}`,
          );
          return 1;
        }
      },
      controller.signal,
    );
  } catch (error) {
    if (controller.signal.aborted) throw new Interrupted('Launcher cancelled');
    throw error;
  } finally {
    spin.clear();
  }
}

const help = `Usage: node examples/launcher/launch.mjs [--dry-run] [--answers <file>] [--id <id>]
       node examples/launcher/launch.mjs resume <id>
       node examples/launcher/launch.mjs summary <id>

Select Harness² or WikiSkill, customize parameters, and automatically validate
the generated Recipe with doctor --static. --dry-run generates and validates
without running. --answers replays saved overrides without prompts.
Run from the source checkout; install dependencies and run pnpm build first.
`;

export async function main(root: string, argv: string[]): Promise<number> {
  try {
    const { values: options, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        answers: { type: 'string' },
        'dry-run': { type: 'boolean' },
        id: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (options.help) {
      process.stdout.write(help);
      return 0;
    }
    if (
      positionals.length &&
      (positionals.length !== 2 ||
        !['resume', 'summary'].includes(positionals[0]) ||
        options.answers ||
        options['dry-run'] ||
        options.id)
    )
      throw new Error(help);
    if (!positionals.length && !options.answers && !interactive())
      throw new Error(
        'Interactive launch needs a terminal. For unattended use, provide --answers <file> (optionally --dry-run).',
      );
    const cli = await createCli(root, { ...process.env });
    ui.intro('ember-rsi example launcher');
    if (positionals.length) {
      const [command, id] = positionals;
      const directory = experimentDirectory(root, id);
      await readFile(join(directory, 'recipe.yaml'), 'utf8');
      if (command === 'summary') {
        const controller = new AbortController();
        const spin = ui.spinner({
          accessible: !interactive(),
          onCancel: () => controller.abort(),
        });
        spin.start('Reading recorded results');
        try {
          const summary = await withDashboard(
            cli,
            (base) => saveSummary(base, id, directory, controller.signal),
            controller.signal,
          );
          spin.stop('Summary ready');
          ui.note(summary, 'Experiment summary');
        } catch (error) {
          if (controller.signal.aborted)
            throw new Interrupted('Summary cancelled');
          throw error;
        } finally {
          spin.clear();
        }
        ui.outro(`Saved ${join(directory, 'summary.md')}`);
        return 0;
      }
      const saved = await readAnswers(join(directory, 'answers.yaml'));
      const template = await loadManifest(root, saved.template);
      const recipe = await readRecipe(join(directory, 'recipe.yaml'));
      await ensureEnvironment(template, recipe, cli);
      await doctor(cli, directory);
      return await run(cli, directory, id, true);
    }
    const templates = await loadTemplates(root);
    const saved = options.answers
      ? await readAnswers(options.answers)
      : undefined;
    const selected =
      saved?.template ??
      answer(
        await ui.select({
          message: 'Choose an example',
          options: templates.map((template) => ({
            value: template.name,
            label: template.manifest.title,
            hint: template.manifest.summary,
          })),
        }),
      );
    const template = templates.find((entry) => entry.name === selected)!;
    let values = applyAnswers(template, saved?.values ?? {}).values;
    const id =
      options.id ??
      `${template.manifest.idPrefix}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
    experimentDirectory(root, id);
    let action = options['dry-run'] ? 'generate' : 'run';
    if (!saved) {
      for (;;) {
        values = await configure(template, values);
        try {
          showConfiguration(template, values, id, cli.env);
        } catch (error) {
          ui.log.error(message(error));
          continue;
        }
        action = answer<string>(
          await ui.select({
            message: 'Next step',
            options: [
              ...(options['dry-run']
                ? []
                : [{ value: 'run', label: 'Start experiment' }]),
              { value: 'generate', label: 'Generate and validate only' },
              { value: 'edit', label: 'Edit parameters' },
              { value: 'save', label: 'Save answers and exit' },
            ],
          }),
        );
        if (action !== 'edit') break;
      }
    } else showConfiguration(template, values, id, cli.env);
    if (action === 'save') {
      const directory = experimentDirectory(root, id);
      await mkdir(dirname(directory), { recursive: true });
      await mkdir(directory);
      await writeFile(
        join(directory, 'answers.yaml'),
        stringify(applyAnswers(template, values).answers),
        { flag: 'wx', mode: 0o600 },
      );
      ui.outro(`Saved ${join(directory, 'answers.yaml')}`);
      return 0;
    }
    const { recipe } = applyAnswers(template, values);
    if (action === 'run')
      await ensureEnvironment(template, recipe, cli, !saved && interactive());
    else {
      const missing = environment(template, recipe).filter(
        (entry) => !cli.env[entry.name]?.trim(),
      );
      if (missing.length)
        ui.log.warn(
          `Required before a real run: ${missing.map((entry) => entry.name).join(', ')}`,
        );
    }
    const directory = await generate(root, id, template, values);
    await doctor(cli, directory);
    if (action === 'generate') {
      ui.outro(
        `Generated ${join(directory, 'recipe.yaml')}; no experiment started.`,
      );
      return 0;
    }
    return await run(cli, directory, id, false);
  } catch (error) {
    if (error instanceof Interrupted) {
      ui.cancel(error.message);
      return 130;
    }
    ui.log.error(message(error));
    return 1;
  }
}
