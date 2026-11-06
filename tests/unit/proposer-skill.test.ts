import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  RuntimeContext,
  type Candidate,
  type JsonObject,
  type ProposerInput,
} from '../../src/contracts/index.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
} from '../../src/runtime/storage/index.js';
import { createFileApplication } from '../../src/plugins/shared/file-application/files.js';
import { proposerSkillDefinition } from '../../src/plugins/proposer-skill/index.js';
import { object, string } from '../../src/shared/json.js';
import { validate } from '../../src/shared/schema.js';
import { proposerContract } from '../../src/contracts/plugin-types/proposer.js';

const skillPath = 'skills/ember-rsi/SKILL.md';
const referencePath = 'skills/ember-rsi/references/workflow.md';
const assetPath = 'skills/ember-rsi/assets/run.mjs';

async function fixture(
  respond: (request: JsonObject) => Promise<JsonObject>,
): Promise<{
  root: string;
  context: RuntimeContext;
  initial: string;
  input: ProposerInput;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'rsi-skill-proposer-'));
  const baseline = join(root, 'baseline');
  for (const [path, content] of [
    [skillPath, 'Original skill'],
    [referencePath, 'Original reference'],
    [assetPath, 'Fixed support material'],
  ]) {
    await mkdir(dirname(join(baseline, path)), { recursive: true });
    await writeFile(join(baseline, path), content);
  }
  const artifacts = new FileArtifacts(join(root, 'artifacts'));
  const candidates = new Map<string, Candidate>();
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected service');
  };
  const services: RuntimeContext = new RuntimeContext().extend({
    rootDirectory: root,
    dataDirectory: root,
    artifacts,
    facts: new FileFacts(join(root, 'facts')),
    workspaces: new FileWorkspaces(join(root, 'workspaces'), artifacts),
    async readCandidate(ref) {
      const candidate = candidates.get(ref);
      if (!candidate) throw new Error('Missing candidate');
      return candidate;
    },
    async recordCandidate(this: RuntimeContext, artifactRef, parentRef) {
      const ref = `candidate-${candidates.size}`;
      candidates.set(ref, {
        ref,
        artifactRef,
        parentRef,
        experimentId: this.experimentId,
      });
      return ref;
    },
    recordMeasurement: unused,
    readMeasurement: unused,
    application: unused,
    applicationMetadata: async () => ({ target: {} }),
    readEvidence: unused,
    invokeAgent: respond,
    invoke: unused,
    withInstance: unused,
    charge: unused,
  });
  const context = services.extend({
    experimentId: 'skill-experiment',
    callId: 'proposal',
    bindingId: 'proposer',
    idempotencyKey: 'proposal',
    directory: join(root, 'calls'),
    signal: new AbortController().signal,
    cleanup: new AbortController().signal,
  });
  const application = await createFileApplication(
    {
      baseline: { directory: baseline },
      target: {
        schema: {
          schemaVersion: 'rsi.target/v1',
          id: 'skill-documents',
          entries: [
            {
              path: skillPath,
              kind: 'file',
              description: 'Reusable skill entry',
              changes: ['modify'],
            },
            {
              path: 'skills/ember-rsi/references',
              kind: 'directory',
              include: ['**/*.md'],
              description: 'Reusable guidance',
              changes: ['create', 'modify', 'delete'],
            },
          ],
        },
      },
    },
    services,
    {
      capability: 'fixture',
      verify: async () => ({}),
      acquire: async () => ({}),
      release: async () => {},
      dispose: async () => {},
    },
  );
  services.application = function (this: RuntimeContext, input) {
    if (input.action !== 'commit') throw new Error('Unexpected action');
    return application.execute(
      {
        action: 'commit',
        parentCandidateRef: string(input.parentCandidateRef),
        editRef: string(input.editRef),
        ...(input.editConstraints
          ? { editConstraints: object(input.editConstraints) }
          : {}),
      },
      this,
    );
  };
  const initialized = await application.execute(
    { action: 'initialize' },
    context,
  );
  if (initialized.action !== 'initialize') throw new Error('Unexpected action');
  return {
    root,
    context,
    initial: initialized.initialCandidateRef,
    input: {
      parent: initialized.initialCandidateRef,
      goal: 'Improve reusable RSI development guidance',
      evidenceRefs: [],
      sources: [],
    },
    async dispose() {
      await application.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('skill Proposer selects and commits the historical base and supplies approved summaries with on-demand traces', async () => {
  let base = '';
  const data = await fixture(async (request) => {
    const input = object(request.input);
    const evidence = object(input.evidence);
    assert.match(JSON.stringify(evidence), /73/);
    assert.match(JSON.stringify(evidence), /pending checks/);
    assert.match(JSON.stringify(evidence), /Human diagnosis/);
    assert.match(JSON.stringify(evidence), /unknown|missing/);
    assert.doesNotMatch(JSON.stringify(evidence), /DEVELOPMENT_TRACE/);
    const files = object(request.files);
    assert.equal(files[`sources/0/${referencePath}`], 'Original reference');
    assert.match(JSON.stringify(files), /DEVELOPMENT_TRACE/);
    assert.match(
      String(request.prompt),
      /quality first|observed quality first/,
    );
    return {
      baseCandidateRef: base,
      baseReason: 'The original guidance has better observed quality.',
      edits: [
        { path: skillPath, content: 'Reusable guidance from observed failure' },
      ],
      reason: 'Hypothesis: verify contract inputs before composing flows.',
    };
  });
  try {
    base = data.initial;
    const original = await data.context.readCandidate(base);
    const current = await data.context.workspaces.create(
      original.artifactRef,
      base,
    );
    await writeFile(join(current.directory, skillPath), 'Regressed skill');
    await writeFile(
      join(current.directory, referencePath),
      'Regressed reference',
    );
    const committed = await data.context.application({
      action: 'commit',
      parentCandidateRef: base,
      editRef: current.ref,
    });
    await data.context.workspaces.release(current.ref);
    const trace = await data.context.artifacts.putJson({
      kind: 'file-tree',
      files: [
        {
          path: 'trajectory.jsonl',
          mode: 420,
          base64: Buffer.from('DEVELOPMENT_TRACE').toString('base64'),
        },
      ],
    });
    const report = await data.context.artifacts.putJson({
      schemaVersion: 'rsi.development-report/v1',
      attemptId: 'attempt-1',
      candidateRef: base,
      development: { status: 'delivered', evidenceRefs: [trace] },
      acceptance: { status: 'failed', issues: ['pending checks'] },
      developmentCost: { totalTokens: 73, modelCalls: null, complete: false },
      evidenceIntegrity: 'unknown',
    });
    const feedback = await data.context.artifacts.putJson({
      schemaVersion: 'rsi.human-feedback/v1',
      issues: ['Human diagnosis: unmet original requirement'],
      action: 'development-problem',
      evidenceIntegrity: 'missing',
    });
    const operation = await proposerSkillDefinition.create({}, data.context);
    const output = await operation.execute(
      {
        ...data.input,
        parent: string(committed.candidateRef),
        sources: [{ candidateRef: base }],
        evidenceRefs: [report, feedback],
      },
      data.context,
    );
    validate(proposerContract.output_schema, output);
    assert.equal(output.status, 'created');
    const candidate = await data.context.readCandidate(output.candidateRef);
    assert.equal(candidate.parentRef, base);
    const snapshot = join(data.root, 'snapshot');
    await data.context.artifacts.materialize(candidate.artifactRef, snapshot);
    assert.equal(
      await readFile(join(snapshot, referencePath), 'utf8'),
      'Original reference',
    );
    assert.equal(
      await readFile(join(snapshot, assetPath), 'utf8'),
      'Fixed support material',
    );
    assert.match(output.rationale, /Base candidate-0|original guidance/);
    const proposalRef = output.rationale.split('Proposal record: ')[1];
    assert.equal(
      object(await data.context.artifacts.readJson(proposalRef))
        .baseCandidateRef,
      base,
    );
    assert.deepEqual(await readdir(join(data.root, 'workspaces')), []);
    await operation.dispose();
  } finally {
    await data.dispose();
  }
});

test('skill Proposer enforces documentation scope and caller constraints and releases rejected workspaces', async () => {
  let response: JsonObject = {};
  const data = await fixture(async () => response);
  try {
    const operation = await proposerSkillDefinition.create({}, data.context);
    for (const path of [
      assetPath,
      'skills/ember-rsi/references/script.ts',
      '../outside.md',
    ]) {
      response = {
        baseCandidateRef: data.initial,
        baseReason: 'Current base',
        reason: 'Change',
        edits: [{ path, content: 'Unallowed' }],
      };
      await assert.rejects(
        operation.execute(data.input, data.context),
        /not authorized|Invalid.*path/,
      );
      assert.deepEqual(await readdir(join(data.root, 'workspaces')), []);
    }
    response = {
      baseCandidateRef: 'unauthorized',
      baseReason: 'Unknown base',
      reason: 'Change',
      edits: [],
    };
    await assert.rejects(
      operation.execute(data.input, data.context),
      /unauthorized baseCandidateRef/,
    );
    response = {
      baseCandidateRef: data.initial,
      baseReason: 'Current base',
      reason: 'Change',
      edits: [{ path: referencePath, content: 'Change' }],
    };
    await assert.rejects(
      operation.execute(
        { ...data.input, editConstraints: { allowedPaths: [skillPath] } },
        data.context,
      ),
      /not authorized/,
    );
    response.edits = [{ path: skillPath, content: 'Change' }];
    data.context.application = async () => {
      throw new Error('Commit failed');
    };
    await assert.rejects(
      operation.execute(data.input, data.context),
      /Commit failed/,
    );
    assert.deepEqual(await readdir(join(data.root, 'workspaces')), []);
    await operation.dispose();
  } finally {
    await data.dispose();
  }
});

test('skill Proposer keeps no-change explicit and supports authorized reference Markdown additions', async () => {
  let change = false;
  const data = await fixture(async () => ({
    baseCandidateRef: data.initial,
    baseReason: 'Use the current skill until contrary evidence appears.',
    reason: change
      ? 'Explain expected input validation.'
      : 'No supported documentation change.',
    edits: change
      ? [
          {
            path: 'skills/ember-rsi/references/nested/new.md',
            content: 'Validate external inputs.',
          },
        ]
      : [],
  }));
  try {
    const operation = await proposerSkillDefinition.create({}, data.context);
    const unchanged = await operation.execute(data.input, data.context);
    assert.equal(unchanged.status, 'no-change');
    assert.equal(unchanged.candidateRef, data.initial);
    assert.equal(unchanged.diffRef, null);
    change = true;
    const changed = await operation.execute(data.input, data.context);
    assert.equal(changed.status, 'created');
    assert.deepEqual(await readdir(join(data.root, 'workspaces')), []);
    await operation.dispose();
  } finally {
    await data.dispose();
  }
});
