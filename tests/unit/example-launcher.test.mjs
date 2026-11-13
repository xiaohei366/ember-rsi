import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import {
  applyAnswers,
  atPath,
  defaults,
  environment,
  experimentDirectory,
  generate,
  loadTemplates,
  parseInput,
  readAnswers,
  rewriteRelativePaths,
} from '../../examples/launcher/lib/config.ts';
import {
  createCli,
  startRun,
  withDashboard,
} from '../../examples/launcher/lib/process.ts';
import {
  changedFiles,
  renderSummary,
  saveSummary,
} from '../../examples/launcher/lib/summary.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
const templates = await loadTemplates(root);
const harness = templates.find((entry) => entry.name === 'harness2');
const wiki = templates.find((entry) => entry.name === 'wikiskill');

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rsi-launcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('launcher manifests track Recipe defaults, convert durations and reject invalid or overlapping task selections', async () => {
  assert.equal(defaults(harness).wall, 72);
  assert.equal(defaults(harness).evalTimeout, 75);
  assert.equal(defaults(harness).memory, true);
  assert.equal(defaults(wiki).rounds, 3);
  const changed = applyAnswers(harness, {
    wall: 1.25,
    evalTimeout: 0.5,
    memory: false,
    k: 1,
  });
  assert.equal(atPath(changed.recipe, 'budget.elapsedWallMs'), 4500000);
  assert.equal(
    atPath(changed.recipe, 'bindings.evaluator.config.run.timeoutSeconds'),
    30,
  );
  assert.deepEqual(changed.answers.values, {
    wall: 1.25,
    evalTimeout: 0.5,
    memory: false,
  });
  assert.equal(atPath(harness.recipe, 'budget.elapsedWallMs'), 259200000);
  assert.throws(() => applyAnswers(harness, { k: 1.5 }), /integer/);
  assert.throws(() => applyAnswers(harness, { k: 11 }), /maximum/);
  assert.throws(() => applyAnswers(harness, { wall: 0 }), /duration/);
  assert.throws(() => applyAnswers(harness, { wall: Infinity }), /finite/);
  assert.throws(() => applyAnswers(harness, { wall: 100000 }), /timer limit/);
  assert.throws(() => applyAnswers(harness, { tasks: ['a', 'a'] }), /unique/);
  assert.throws(
    () => applyAnswers(harness, { MODEL_API_KEY: 'secret' }),
    /Unknown answer/,
  );
  assert.throws(
    () => applyAnswers(wiki, { trainTasks: ['same'], testTasks: ['same'] }),
    /overlap/,
  );
  assert.throws(() => applyAnswers(wiki, { validationTasks: [] }), /at least/);
  assert.deepEqual(
    applyAnswers(wiki, { testTasks: [], rounds: 0 }).values.testTasks,
    [],
  );
  const drifted = structuredClone(harness);
  delete drifted.recipe.policy.config.k;
  assert.throws(() => defaults(drifted), /path is absent/);
});

test('launcher supports pasted lists and files, validates answer files, and discovers environment references without confusing expressions', async (t) => {
  const directory = await temporary(t);
  const param = harness.params.find((entry) => entry.key === 'tasks');
  assert.deepEqual(await parseInput(param, 'task/a, task/b\ntask/c'), [
    'task/a',
    'task/b',
    'task/c',
  ]);
  const file = join(directory, 'tasks.yaml');
  await writeFile(file, '- task/a\n- task/b\n');
  assert.deepEqual(await parseInput(param, `@${file}`), ['task/a', 'task/b']);
  await assert.rejects(
    parseInput(param, '@' + join(directory, 'missing')),
    /ENOENT/,
  );
  const answers = join(directory, 'answers.yaml');
  await writeFile(
    answers,
    'schemaVersion: rsi.launch.answers/v1\ntemplate: harness2\nvalues: {}\nsecret: no\n',
  );
  await assert.rejects(readAnswers(answers), /Answers/);
  const vars = environment(harness, {
    ...harness.recipe,
    extra: '${EXTRA_TOKEN}',
    expression: '${{ application.initialCandidate }}',
  });
  assert.equal(vars.find((entry) => entry.name === 'EXTRA_TOKEN').secret, true);
  assert.equal(
    vars.filter((entry) => entry.name === 'MODEL_API_KEY').length,
    1,
  );
  assert.equal(vars.length, 5);
});

test('generation preserves references and candidate paths, writes only overrides, and never overwrites a resume directory', async (t) => {
  const workspace = await temporary(t);
  const rewritten = rewriteRelativePaths(
    {
      nested: ['./target.yaml', '../shared/guidance'],
      bare: 'plugins/a.md',
      expression: '${{ application.initialCandidate }}',
      env: '${MODEL_API_KEY}',
      url: 'https://example.invalid/a',
    },
    dirname(harness.file),
  );
  assert.deepEqual(rewritten.nested, [
    resolve(dirname(harness.file), 'target.yaml'),
    resolve(dirname(harness.file), '../shared/guidance'),
  ]);
  assert.equal(rewritten.bare, 'plugins/a.md');
  assert.equal(rewritten.env, '${MODEL_API_KEY}');
  assert.equal(rewritten.expression, '${{ application.initialCandidate }}');
  const directory = await generate(workspace, 'sample', harness, { wall: 2 });
  const before = await readFile(join(directory, 'recipe.yaml'), 'utf8');
  assert.equal(
    parse(before).application.config.target.schema,
    resolve(dirname(harness.file), 'target.yaml'),
  );
  assert.match(before, /\$\{MODEL_API_KEY\}/);
  assert.deepEqual(
    (await readAnswers(join(directory, 'answers.yaml'))).values,
    { wall: 2 },
  );
  await assert.rejects(
    generate(workspace, 'sample', harness, { wall: 3 }),
    /EEXIST/,
  );
  assert.equal(await readFile(join(directory, 'recipe.yaml'), 'utf8'), before);
  assert.throws(
    () => experimentDirectory(workspace, '../escape'),
    /Experiment ID/,
  );
});

const metric = (value) => ({
  name: 'reward',
  definitionRef: 'metric-v1',
  unit: 'ratio',
  status: 'available',
  values: { mean: value },
});
const measurement = (
  ref,
  candidateRef,
  value,
  comparisonKey = 'validation',
) => ({
  ref,
  candidateRef,
  status: 'succeeded',
  coverage: 'complete',
  comparisonKey,
  metrics: [metric(value)],
});
const candidates = [
  { ref: 'base', parentRef: null, artifactRef: 'artifact:base' },
  { ref: 'final', parentRef: 'base', artifactRef: 'artifact:final' },
];
const record = {
  id: 'sample',
  status: 'succeeded',
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: '2026-01-01T00:01:00Z',
  error: null,
  usage: { evaluationRuns: 3 },
  limits: { evaluationRuns: 5 },
};
const references = [
  { kind: 'candidate', ref: 'final', path: '/candidateRef' },
  { kind: 'measurement', ref: 'val', path: '/measurementRef' },
  { kind: 'measurement', ref: 'test', path: '/testMeasurementRef' },
];

test('summary follows returned measurements and compares only a unique compatible baseline, preserving zero and unknown values', () => {
  const measurements = [
    measurement('baseline', 'base', 0),
    measurement('val', 'final', 0.5),
    measurement('test', 'final', 0.9, 'independent-test'),
    measurement('unrelated', 'final', 999),
  ];
  const summary = renderSummary(record, references, measurements, candidates);
  assert.match(summary, /0\.5 \| 0 \| \+0\.5/);
  assert.match(summary, /0\.9 \| — \| —/);
  assert.doesNotMatch(summary, /999/);
  assert.match(summary, /testMeasurementRef/);
  assert.doesNotMatch(
    renderSummary(
      record,
      references,
      [...measurements, measurement('ambiguous', 'base', 0)],
      candidates,
    ),
    /\+0\.5/,
  );
  assert.match(
    renderSummary(record, [], measurements, candidates),
    /No final score is inferred/,
  );
  assert.deepEqual(
    changedFiles(
      [
        { path: 'same', digest: '1' },
        { path: 'removed', digest: '2' },
        { path: 'secret' },
        { path: 'edit', digest: 'old' },
      ],
      [
        { path: 'same', digest: '1' },
        { path: 'added', digest: '3' },
        { path: 'secret' },
        { path: 'edit', digest: 'new' },
      ],
    ),
    ['A added', 'M edit', 'D removed', '? secret'],
  );
});

// A local CLI substitute exercises launcher ownership and public command/API boundaries.
// It never loads Runtime, credentials, Docker or model backends.
const fakeCli = String.raw`
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';
const args = process.argv.slice(2), command = args[0];
const read = async () => JSON.parse(await readFile('record.json', 'utf8'));
await appendFile('commands.jsonl', JSON.stringify(args) + '\n');
if (command === 'doctor') {
  const failed = process.env.FAKE_DOCTOR_FAIL === '1';
  console.log(JSON.stringify({ summary: { passed: failed ? 0 : 1, failed: failed ? 1 : 0, unchecked: 1 }, checks: failed ? [{ id: 'resource', status: 'failed', reason: 'missing fixture' }] : [], missingResources: [] }));
  process.exitCode = failed ? 1 : 0;
} else if (command === 'dashboard') {
  await writeFile('dashboard.pid', String(process.pid));
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const path = new URL(req.url, 'http://localhost');
    try {
      let result = await read();
      if (path.pathname.endsWith('/details')) result = { resultReferences: [] };
      else if (path.pathname.endsWith('/candidates') || path.pathname.endsWith('/measurements')) result = { items: [], nextOffset: null, total: 0 };
      res.end(JSON.stringify(result));
    } catch { res.statusCode = 404; res.end('{}'); }
  });
  server.listen(Number(args.at(-1)), '127.0.0.1', () => console.log('Dashboard open at http://127.0.0.1:' + server.address().port));
  setTimeout(() => { server.closeAllConnections(); server.close(); }, 10000).unref();
} else if (command === 'run') {
  const id = args[args.indexOf('--id') + 1];
  const record = { id, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null, usage: {}, limits: {} };
  await writeFile('record.json', JSON.stringify(record));
  console.log('fixture run started');
  if (process.env.FAKE_WAIT_CANCEL === '1') {
    const deadline = Date.now() + 5000;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 20));
      if ((await read()).status === 'cancelled') break;
      if (Date.now() > deadline) throw new Error('Fixture cancellation deadline exceeded');
    }
  } else {
    await new Promise(resolve => setTimeout(resolve, 50));
    record.status = 'succeeded'; record.finishedAt = new Date().toISOString();
    await writeFile('record.json', JSON.stringify(record));
  }
  console.log('fixture run ended');
} else if (command === 'cancel') {
  const record = await read(); record.status = 'cancelled'; record.finishedAt = new Date().toISOString();
  await writeFile('record.json', JSON.stringify(record)); console.log('{}');
}
`;

async function fixture(t) {
  const directory = await temporary(t);
  for (const name of ['dsh-harness2', 'dsh-wikiskill']) {
    const target = join(directory, 'examples/harness', name);
    await mkdir(target, { recursive: true });
    for (const file of ['launch.yaml', 'recipe.yaml'])
      await cp(join(root, 'examples/harness', name, file), join(target, file));
  }
  const cliPath = join(directory, 'dist/src/entries/cli/main.js');
  await mkdir(dirname(cliPath), { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(cliPath, fakeCli);
  await writeFile(
    join(directory, 'answers.yaml'),
    stringify({
      schemaVersion: 'rsi.launch.answers/v1',
      template: 'harness2',
      values: {},
    }),
  );
  const entry = new URL('../../examples/launcher/lib/main.ts', import.meta.url)
    .href;
  const launcher = join(directory, 'launch.mjs');
  await writeFile(
    launcher,
    `import { main } from ${JSON.stringify(entry)};
import { readFile } from 'node:fs/promises';
if (process.env.FAKE_INTERRUPT === '1') {
  const timer = setInterval(async () => {
    try {
      if (JSON.parse(await readFile('record.json', 'utf8')).status === 'running') {
        clearInterval(timer);
        process.emit('SIGINT');
      }
    } catch {}
  }, 20);
  timer.unref();
}
process.exitCode = await main(${JSON.stringify(directory)}, process.argv.slice(2));`,
  );
  const env = {
    ...process.env,
    MODEL_NAME: 'fixture',
    EVALUATOR_MODEL_NAME: 'fixture',
    MODEL_ENDPOINT: 'https://example.invalid',
    MODEL_API_KEY: 'fixture-secret-value',
    NO_COLOR: '1',
    CI: '1',
  };
  return { directory, launcher, env, cli: await createCli(directory, env) };
}

async function invoke(fixture, args, env = fixture.env) {
  return execute(process.execPath, [fixture.launcher, ...args], {
    cwd: fixture.directory,
    env,
    windowsHide: true,
    timeout: 20000,
  });
}

async function commands(directory) {
  return (await readFile(join(directory, 'commands.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
}

function assertStopped(pid) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('unattended generation always runs static doctor; failures block run and preserve a report without saving credentials', async (t) => {
  const f = await fixture(t);
  await invoke(f, ['--answers', 'answers.yaml', '--id', 'dry', '--dry-run']);
  assert.deepEqual(
    (await commands(f.directory)).map((entry) => entry[0]),
    ['doctor'],
  );
  assert.equal((await commands(f.directory))[0].at(-1), '--static');
  const output = join(f.directory, '.rsi/launcher/dry');
  assert.equal(
    JSON.parse(await readFile(join(output, 'doctor.json'), 'utf8')).summary
      .failed,
    0,
  );
  for (const file of ['answers.yaml', 'recipe.yaml', 'doctor.json'])
    assert.doesNotMatch(
      await readFile(join(output, file), 'utf8'),
      /fixture-secret-value/,
    );
  await assert.rejects(
    invoke(f, ['--answers', 'answers.yaml', '--id', 'failed'], {
      ...f.env,
      FAKE_DOCTOR_FAIL: '1',
    }),
    (error) =>
      error.code === 1 && error.stdout.includes('Static validation failed'),
  );
  assert.equal(
    (await commands(f.directory)).some((entry) => entry[0] === 'run'),
    false,
  );
  assert.equal(
    JSON.parse(
      await readFile(
        join(f.directory, '.rsi/launcher/failed/doctor.json'),
        'utf8',
      ),
    ).summary.failed,
    1,
  );
});

test('simulated run writes logs and summary, closes dashboard, and resume uses the saved Recipe even if source defaults change', async (t) => {
  const f = await fixture(t);
  await invoke(f, ['--answers', 'answers.yaml', '--id', 'run']);
  const directory = join(f.directory, '.rsi/launcher/run');
  assert.match(
    await readFile(join(directory, 'summary.md'), 'utf8'),
    /succeeded/,
  );
  assert.match(
    await readFile(join(directory, 'run.log'), 'utf8'),
    /fixture run ended/,
  );
  assertStopped(
    Number(await readFile(join(f.directory, 'dashboard.pid'), 'utf8')),
  );
  const original = await readFile(join(directory, 'recipe.yaml'), 'utf8');
  await writeFile(
    join(f.directory, 'examples/harness/dsh-harness2/recipe.yaml'),
    'schemaVersion: broken\n',
  );
  await invoke(f, ['resume', 'run']);
  const calls = (await commands(f.directory)).filter(
    (entry) => entry[0] === 'run',
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], calls[1][1]);
  assert.equal(calls[1].at(-1), '--resume');
  assert.equal(
    await readFile(join(directory, 'recipe.yaml'), 'utf8'),
    original,
  );
  assertStopped(
    Number(await readFile(join(f.directory, 'dashboard.pid'), 'utf8')),
  );
});

test('dashboard closes after query failure; detached CLI can be cancelled through the public command and retains its log', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.directory, '.rsi'));
  await assert.rejects(
    withDashboard(f.cli, (base) => saveSummary(base, 'missing', f.directory)),
    /HTTP 404/,
  );
  assertStopped(
    Number(await readFile(join(f.directory, 'dashboard.pid'), 'utf8')),
  );
  const controller = new AbortController();
  await assert.rejects(
    withDashboard(
      f.cli,
      async (base) => {
        controller.abort(new Error('Summary interrupted'));
        return saveSummary(base, 'missing', f.directory, controller.signal);
      },
      controller.signal,
    ),
    /Summary interrupted/,
  );
  assertStopped(
    Number(await readFile(join(f.directory, 'dashboard.pid'), 'utf8')),
  );
  const cli = await createCli(f.directory, { ...f.env, FAKE_WAIT_CANCEL: '1' });
  const run = await startRun(cli, f.directory, 'cancel', false);
  t.after(() => {
    if (run.child.exitCode === null) run.child.kill();
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await readFile(join(f.directory, 'record.json'));
      break;
    } catch {
      assert.ok(attempt < 100);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  run.child.unref();
  assert.equal((await cli.call(['cancel', 'cancel'])).code, 0);
  assert.equal((await run.finished).code, 0);
  assert.equal(
    JSON.parse(await readFile(join(f.directory, 'record.json'), 'utf8')).status,
    'cancelled',
  );
  assert.match(
    await readFile(join(f.directory, 'run.log'), 'utf8'),
    /fixture run ended/,
  );
});

test('noninteractive interrupt requests cancellation, waits for the run, reports cancellation and closes the dashboard', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    invoke(f, ['--answers', 'answers.yaml', '--id', 'cancelled'], {
      ...f.env,
      FAKE_WAIT_CANCEL: '1',
      FAKE_INTERRUPT: '1',
    }),
    (error) => error.code === 130,
  );
  assert.equal(
    (await commands(f.directory)).filter((entry) => entry[0] === 'cancel')
      .length,
    1,
  );
  assert.match(
    await readFile(
      join(f.directory, '.rsi/launcher/cancelled/summary.md'),
      'utf8',
    ),
    /cancelled/,
  );
  assert.match(
    await readFile(
      join(f.directory, '.rsi/launcher/cancelled/run.log'),
      'utf8',
    ),
    /fixture run ended/,
  );
  assertStopped(
    Number(await readFile(join(f.directory, 'dashboard.pid'), 'utf8')),
  );
});

test('summary reads every observation page and keeps unavailable metrics and restricted file digests explicit', async (t) => {
  const directory = await temporary(t);
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    seen.push(url.pathname + url.search);
    const page = (items, nextOffset = null) => ({
      items,
      nextOffset,
      total: items.length,
    });
    let result;
    if (url.pathname.endsWith('/details'))
      result = { resultReferences: references };
    else if (url.pathname.endsWith('/candidates')) result = page(candidates);
    else if (url.pathname.endsWith('/measurements'))
      result =
        url.searchParams.get('offset') === '0'
          ? page([measurement('baseline', 'base', 0)], 1)
          : page([
              measurement('val', 'final', 0.5),
              {
                ...measurement('test', 'final', 0, 'test'),
                metrics: [{ ...metric(0), status: 'unavailable', values: {} }],
              },
            ]);
    else if (url.pathname.includes('/artifacts/'))
      result = {
        kind: 'file-tree',
        files: page([
          {
            path: 'skill.md',
            digest: url.pathname.endsWith('base') ? 'old' : 'new',
          },
          { path: '.env' },
        ]),
      };
    else result = record;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const summary = await saveSummary(
    `http://127.0.0.1:${server.address().port}`,
    'sample',
    directory,
  );
  assert.ok(seen.some((url) => url.includes('measurements?offset=1')));
  assert.match(summary, /0\.5 \| 0 \| \+0\.5/);
  assert.match(summary, /unavailable\) \| unknown/);
  assert.match(summary, /M skill\.md/);
  assert.match(summary, /\? \.env/);
});
