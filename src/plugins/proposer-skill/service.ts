import { fileURLToPath } from 'node:url';
import type {
  JsonObject,
  OperationDefinition,
  ProposerInput,
  ProposerOutput,
  RuntimeContext,
} from '../../contracts/index.js';
import { applicationContract } from '../../contracts/plugin-types/application.js';
import { object, string, strings } from '../../shared/json.js';
import { parseConfig, validate } from '../../shared/schema.js';
import {
  applyEdits,
  requestEdit,
  resourceFiles,
  validateEdits,
  type ReadOnlyEditContext,
} from '../shared/agent-editing/index.js';
import {
  configSchema,
  proposalSchema,
  skillEditConstraints,
  type SkillProposerConfig,
} from './schema.js';

/** Keep details in read-only virtual files rather than in every proposal prompt. */
async function proposalEvidence(
  refs: string[],
  context: RuntimeContext,
): Promise<ReadOnlyEditContext> {
  const summaries: JsonObject[] = [];
  const files: JsonObject = {};
  for (const [index, ref] of refs.entries()) {
    const summary = object(await context.artifacts.readJson(ref));
    const details: JsonObject[] = [];
    if (summary.schemaVersion === 'rsi.development-report/v1') {
      const development = object(summary.development);
      const detailRefs = new Set([
        ...(typeof development.executionRef === 'string'
          ? [development.executionRef]
          : []),
        ...strings(development.evidenceRefs ?? []),
      ]);
      for (const [detailIndex, detailRef] of [...detailRefs].entries()) {
        const prefix = `context/details/${index}/${detailIndex}`;
        try {
          const detail = await context.artifacts.readJson(detailRef);
          const paths: string[] = [];
          if (
            detail !== null &&
            !Array.isArray(detail) &&
            typeof detail === 'object' &&
            detail.kind === 'file-tree'
          ) {
            for (const [path, content] of Object.entries(
              await resourceFiles(detailRef, context),
            )) {
              const name = `${prefix}/${path}`;
              files[name] = content;
              paths.push(name);
            }
          } else {
            files[`${prefix}.json`] = JSON.stringify(detail, null, 2);
            paths.push(`${prefix}.json`);
          }
          details.push({ artifactRef: detailRef, files: paths });
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            )
          )
            throw error;
          details.push({
            artifactRef: detailRef,
            integrity: 'missing',
            files: [],
          });
        }
      }
    }
    summaries.push({ artifactRef: ref, summary, details });
  }
  return {
    files,
    evidence: { summaries },
    input: {
      historicalEvidence: 'summary-first; detailed files are read-only',
    },
  };
}

export const createProposerSkill: OperationDefinition<
  ProposerInput,
  ProposerOutput,
  SkillProposerConfig
>['create'] = async (rawConfig, services) => {
  const config = parseConfig<SkillProposerConfig>(
    configSchema,
    rawConfig,
    'proposer.skill config',
  );
  return {
    async execute(input, context): Promise<ProposerOutput> {
      const current = await context.readCandidate(input.parent);
      const bases = new Set([
        input.parent,
        ...(input.sources ?? []).map((source) => source.candidateRef),
      ]);
      const response = await requestEdit(
        {
          ...config,
          prompt:
            config.prompt ??
            fileURLToPath(new URL('./prompt.md', import.meta.url)),
        },
        {
          ...input,
          target: (await context.applicationMetadata()).target ?? null,
        },
        current.artifactRef,
        context,
        await proposalEvidence(input.evidenceRefs, context),
        proposalSchema,
      );
      const baseRef = string(response.baseCandidateRef);
      if (!bases.has(baseRef))
        throw new Error(
          'Skill proposal selected an unauthorized baseCandidateRef',
        );
      const base = await context.readCandidate(baseRef);
      const workspace = await services.workspaces.create(
        base.artifactRef,
        base.ref,
      );
      try {
        // The caller may narrow the scope further; it cannot authorize fixed assets.
        await validateEdits(
          workspace.directory,
          response,
          context,
          skillEditConstraints,
        );
        await applyEdits(
          workspace.directory,
          response,
          context,
          input.editConstraints,
        );
        const committed = await context.application({
          action: 'commit',
          parentCandidateRef: base.ref,
          editRef: workspace.ref,
          ...(input.editConstraints
            ? { editConstraints: input.editConstraints }
            : {}),
        });
        validate(
          applicationContract.output_schema,
          committed,
          'Application commit output',
        );
        if (committed.action !== 'commit')
          throw new Error('Application did not return a commit result');
        const proposalRef = await context.artifacts.putJson({
          schemaVersion: 'rsi.skill-proposal/v1',
          previousCandidateRef: current.ref,
          baseCandidateRef: base.ref,
          baseReason: response.baseReason,
          candidateRef: committed.candidateRef,
          status: committed.status,
          reason: response.reason,
          evidenceRefs: input.evidenceRefs,
        });
        const rationale = `Base ${base.ref}: ${string(response.baseReason)}\n${string(response.reason)}\nProposal record: ${proposalRef}`;
        const candidateRef = string(committed.candidateRef);
        if (committed.status === 'created')
          return {
            status: 'created',
            candidateRef,
            diffRef: string(committed.diffRef),
            rationale,
          };
        if (committed.status !== 'no-change' || committed.diffRef !== null)
          throw new Error('Invalid no-change Application commit output');
        return { status: 'no-change', candidateRef, diffRef: null, rationale };
      } finally {
        await services.workspaces.release(workspace.ref);
      }
    },
    async dispose(): Promise<void> {},
  };
};
