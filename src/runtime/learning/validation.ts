import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonObject, JsonSchema } from '../../contracts/json.js';
import {
  learningDeclarationSchemas,
  type LearningKind,
  type LearningObserve,
  type MemoryDeclaration,
  type ReflectionDeclaration,
} from '../../contracts/learning.js';
import { digest, object, string } from '../../shared/json.js';
import { configPathFields, isResourceUrl } from '../../shared/paths.js';
import { validate } from '../../shared/schema.js';
import { mergeDeclarations, type Binding } from '../loaders/binding.js';
import { pointerParent, resolvePaths } from '../loaders/config.js';
import type { Policy } from '../policy/policy.js';
import type { Registry } from '../registry/index.js';
import { safeId } from '../storage/index.js';
import {
  pointerValue,
  selectedResourceFields,
  validateEditableDestinations,
} from './resources.js';
import { compileTrigger, resolveTriggerTarget } from './trigger.js';
import type { MemoryConfig, ReflectionConfig } from './schema.js';
export type { MemoryConfig, ReflectionConfig } from './schema.js';

interface Resolution {
  policy: Policy;
  override?: JsonObject;
  recipeDirectory: string;
  bindings: Readonly<Record<string, Binding>>;
  registry: Registry;
  memoryEnabled: boolean;
}

async function validatePath(
  path: string,
  kind: 'file' | 'directory',
  label: string,
): Promise<void> {
  const info = await lstat(path).catch((cause: unknown) => {
    throw new Error(`${label}: cannot read resource ${path}`, { cause });
  });
  if (
    info.isSymbolicLink() ||
    !(kind === 'file' ? info.isFile() : info.isDirectory())
  )
    throw new Error(`${label}: expected a regular ${kind} resource at ${path}`);
}
async function validatePaths(
  schema: JsonSchema,
  config: JsonObject,
  label: string,
): Promise<void> {
  for (const field of configPathFields(schema, config)) {
    const { parent, key } = pointerParent(config, field.pointer);
    const path = string(
      Array.isArray(parent) ? parent[Number(key)] : parent[key],
    );
    if (!isResourceUrl(path))
      await validatePath(path, field.kind, label + field.pointer);
  }
}

export function validateLearning(
  kind: 'memory',
  source: Resolution,
): Promise<MemoryConfig | undefined>;
export function validateLearning(
  kind: 'reflection',
  source: Resolution,
): Promise<ReflectionConfig | undefined>;
export async function validateLearning(
  kind: LearningKind,
  source: Resolution,
): Promise<MemoryConfig | ReflectionConfig | undefined> {
  const { policy, registry, bindings } = source;
  if (policy.defaults[kind] === undefined && source.override === undefined)
    return undefined;
  const defaults = structuredClone(object(policy.defaults[kind] ?? {}));
  const override = source.override ?? {};
  if (override.goalFile !== undefined) delete defaults.goal;
  if (override.goal !== undefined) delete defaults.goalFile;
  if (override.seed !== undefined) delete defaults.seed;
  if (override.trigger !== undefined) delete defaults.trigger;
  if (
    override.plugin !== undefined &&
    (defaults.plugin ?? `${kind}.agent`) !== override.plugin
  )
    delete defaults.config;
  const merged = mergeDeclarations(
    defaults,
    override,
    policy.defaults[kind] === undefined
      ? source.recipeDirectory
      : (pointer) => policy.resourceDirectory('/defaults/' + kind + pointer),
    source.recipeDirectory,
  );
  validate(learningDeclarationSchemas[kind], merged.value, kind);
  const declaration: MemoryDeclaration & ReflectionDeclaration = merged.value;
  if (declaration.enabled === false) return undefined;
  if (!declaration.trigger) throw new Error(`${kind}.trigger is required`);
  const trigger = (
    Array.isArray(declaration.trigger)
      ? declaration.trigger
      : [declaration.trigger]
  ).map((entry) => compileTrigger(entry, policy.flowIndex));
  const plugin = declaration.plugin ?? `${kind}.agent`;
  registry.assertContract(registry.contract(`contract.${kind}`), plugin, kind);
  const definition = registry.get(plugin);
  let config = declaration.config ?? {};
  if (plugin === `${kind}.agent`) {
    const agents = Object.keys(bindings).filter(
      (name) => policy.requirements[name]?.id === 'contract.agent',
    );
    config.agentRef ??= agents.includes('agent')
      ? 'agent'
      : agents.length === 1
        ? agents[0]!
        : '';
    if (
      typeof config.agentRef !== 'string' ||
      !agents.includes(config.agentRef)
    )
      throw new Error(
        `${kind}.config.agentRef must select a declared contract.agent binding`,
      );
    config.prompt ??= fileURLToPath(
      new URL(`../../plugins/${kind}-agent/prompt.md`, import.meta.url),
    );
  }
  validate(definition.configSchema, config, `${kind}.config`);
  config = resolvePaths(config, definition.configSchema, (pointer) =>
    merged.directory('/config' + pointer),
  );
  await validatePaths(definition.configSchema, config, `${kind}.config`);
  const goalFile = declaration.goalFile
    ? resolve(merged.directory('/goalFile'), declaration.goalFile)
    : !declaration.goal && kind === 'reflection'
      ? fileURLToPath(
          new URL(
            '../../plugins/reflection-agent/goals/generic/prompt.md',
            import.meta.url,
          ),
        )
      : undefined;
  let goal =
    declaration.goal ??
    'Consolidate reusable experience grounded in observed evidence.';
  if (goalFile !== undefined) {
    await validatePath(goalFile, 'file', `${kind}.goalFile`);
    goal = new TextDecoder('utf-8', { fatal: true }).decode(
      await readFile(goalFile),
    );
    if (!goal.trim()) throw new Error(`${kind}.goalFile is empty: ${goalFile}`);
  }
  const observe: LearningObserve = {
    includeBaseline: false,
    includeCandidateSources: false,
    includeCandidateDiffs: kind === 'memory',
    includeAgentTraces: kind === 'reflection',
    includeDocumentPreviews: kind === 'reflection',
    includeRevisionComparisons: kind === 'reflection',
    ...declaration.observe,
  };
  if (observe.bindings === undefined && observe.steps === undefined) {
    observe.bindings = Object.keys(bindings).filter(
      (name) => policy.requirements[name]?.id !== 'contract.agent',
    );
    if (kind === 'reflection' && source.memoryEnabled)
      observe.bindings.push('memory');
  }
  for (const name of observe.bindings ?? [])
    if (
      !Object.hasOwn(bindings, name) &&
      !(kind === 'reflection' && name === 'memory')
    )
      throw new Error(`${kind}.observe.bindings: unknown binding ${name}`);
  for (const field of ['steps', 'excludeSteps'] as const)
    if (observe[field])
      observe[field] = observe[field].map(
        (id) => resolveTriggerTarget(policy.flowIndex, id).location,
      );
  const { timeoutSeconds, ...limits } = declaration.budget ?? {};
  const common = {
    plugin,
    config,
    trigger,
    observe,
    goal,
    ...(goalFile ? { goalFile } : {}),
    evidenceView: declaration.evidenceView ?? 'execution',
    budget: {
      ...limits,
      ...(timeoutSeconds !== undefined
        ? { elapsedWallMs: timeoutSeconds * 1000 }
        : {}),
    },
  };
  if (kind === 'memory') {
    const consumers =
      declaration.consumers ??
      Object.keys(bindings).filter(
        (name) => policy.requirements[name]?.id === 'contract.proposer',
      );
    if (
      !consumers.length ||
      consumers.some((name) => !Object.hasOwn(bindings, name))
    )
      throw new Error('memory.consumers must select declared bindings');
    let seed = declaration.seed;
    if (seed?.directory !== undefined) {
      const directory = resolve(
        merged.directory('/seed/directory'),
        seed.directory,
      );
      await validatePath(directory, 'directory', 'memory.seed.directory');
      seed = { directory };
    }
    if (seed?.fromExperiment !== undefined) safeId(seed.fromExperiment);
    const result = {
      ...common,
      consumers,
      ...(seed ? { seed } : {}),
      ...(declaration.editConstraints
        ? { editConstraints: declaration.editConstraints }
        : {}),
    };
    return { ...result, digest: digest(result) };
  }
  const targets = declaration.targets;
  if (!targets || !Object.keys(targets).length)
    throw new Error('reflection.targets must not be empty');
  const destinations = [];
  for (const [name, target] of Object.entries(targets)) {
    const binding = bindings[name];
    if (!binding)
      throw new Error(`reflection.targets.${name}: unknown binding`);
    await validatePaths(
      binding.definition.configSchema,
      binding.config,
      `reflection.targets.${name}`,
    );
    for (const field of selectedResourceFields(
      binding.definition.configSchema,
      binding.config,
      target.resources,
    ))
      destinations.push({
        binding: name,
        ...field,
        path: string(pointerValue(binding.config, field.pointer)),
      });
  }
  await validateEditableDestinations(destinations);
  const result = { ...common, targets };
  return { ...result, digest: digest(result) };
}
