import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Ajv } from 'ajv';
import { parse, stringify } from 'yaml';

export type Value =
  | string
  | number
  | boolean
  | null
  | Value[]
  | { [key: string]: Value };
export type Recipe = { [key: string]: Value };
export type Answer = string | number | boolean | string[];
export interface Parameter {
  key: string;
  label: string;
  path: string;
  type: 'string' | 'int' | 'bool' | 'enum' | 'duration' | 'list';
  min?: number;
  max?: number;
  unit?: 'h' | 'min' | 's';
  store?: 'ms' | 's';
  options?: string[];
}
export interface EnvironmentVariable {
  name: string;
  label: string;
  secret?: boolean;
}
export interface Manifest {
  schemaVersion: 'rsi.launch/v1';
  recipe: string;
  title: string;
  summary: string;
  idPrefix: string;
  env: EnvironmentVariable[];
  groups: { title: string; advanced?: boolean; params: Parameter[] }[];
  disjoint?: string[][];
  estimate?: { factor: number; parameters: string[] };
}
export interface Template {
  name: string;
  file: string;
  manifest: Manifest;
  recipe: Recipe;
  params: Parameter[];
}
export interface Answers {
  schemaVersion: 'rsi.launch.answers/v1';
  template: string;
  values: Record<string, Answer>;
}

const templates = {
  harness2: 'examples/harness/dsh-harness2/launch.yaml',
  wikiskill: 'examples/harness/dsh-wikiskill/launch.yaml',
};
const word = { type: 'string', minLength: 1 };
const ajv = new Ajv({ allErrors: true });
const validateManifest = ajv.compile<Manifest>({
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'recipe',
    'title',
    'summary',
    'idPrefix',
    'env',
    'groups',
  ],
  properties: {
    schemaVersion: { const: 'rsi.launch/v1' },
    recipe: word,
    title: word,
    summary: word,
    idPrefix: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
    env: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'label'],
        properties: {
          name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
          label: word,
          secret: { type: 'boolean' },
        },
      },
    },
    groups: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'params'],
        properties: {
          title: word,
          advanced: { type: 'boolean' },
          params: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['key', 'label', 'path', 'type'],
              properties: {
                key: { type: 'string', pattern: '^[a-z][a-zA-Z0-9]*$' },
                label: word,
                path: word,
                type: {
                  enum: ['string', 'int', 'bool', 'enum', 'duration', 'list'],
                },
                min: { type: 'number', minimum: 0 },
                max: { type: 'number', minimum: 0 },
                unit: { enum: ['h', 'min', 's'] },
                store: { enum: ['ms', 's'] },
                options: {
                  type: 'array',
                  minItems: 1,
                  uniqueItems: true,
                  items: word,
                },
              },
            },
          },
        },
      },
    },
    disjoint: {
      type: 'array',
      items: { type: 'array', minItems: 2, uniqueItems: true, items: word },
    },
    estimate: {
      type: 'object',
      additionalProperties: false,
      required: ['factor', 'parameters'],
      properties: {
        factor: { type: 'number', minimum: 0 },
        parameters: { type: 'array', minItems: 1, items: word },
      },
    },
  },
});
const validateAnswers = ajv.compile<Answers>({
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'template', 'values'],
  properties: {
    schemaVersion: { const: 'rsi.launch.answers/v1' },
    template: { enum: Object.keys(templates) },
    values: {
      type: 'object',
      additionalProperties: {
        anyOf: [
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
          { type: 'array', items: word },
        ],
      },
    },
  },
});

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label}: expected an object`);
  return value as Record<string, unknown>;
}

export async function readYaml(file: string): Promise<unknown> {
  return parse(await readFile(file, 'utf8'));
}

export async function readRecipe(file: string): Promise<Recipe> {
  const raw = object(await readYaml(file), 'Recipe');
  const convert = (value: unknown): Value => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    )
      return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(convert);
    return Object.fromEntries(
      Object.entries(object(value, 'Recipe value')).map(([key, item]) => [
        key,
        convert(item),
      ]),
    );
  };
  if (raw.schemaVersion !== 'rsi.recipe/v1')
    throw new Error('Recipe schemaVersion must be rsi.recipe/v1');
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, convert(value)]),
  );
}

export async function loadManifest(
  root: string,
  name: string,
): Promise<{ manifest: Manifest; file: string }> {
  const manifestPath = Object.entries(templates).find(
    ([key]) => key === name,
  )?.[1];
  if (!manifestPath) throw new Error(`Unknown template: ${name}`);
  const raw = await readYaml(resolve(root, manifestPath));
  if (!validateManifest(raw))
    throw new Error(
      `${manifestPath}: ${ajv.errorsText(validateManifest.errors)}`,
    );
  return {
    manifest: raw,
    file: resolve(root, dirname(manifestPath), raw.recipe),
  };
}

export function atPath(recipe: Recipe, path: string): Value {
  let value: Value = recipe;
  for (const key of path.split('.')) {
    if (
      ['__proto__', 'constructor', 'prototype'].includes(key) ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.hasOwn(value, key)
    ) {
      throw new Error(`Manifest path is absent from recipe: ${path}`);
    }
    value = value[key];
  }
  return value;
}

function ratio(param: Parameter): number {
  const units = { h: 3600000, min: 60000, s: 1000 };
  if (!param.unit || !param.store)
    throw new Error(`${param.key}: duration requires unit and store`);
  return units[param.unit] / (param.store === 'ms' ? 1 : 1000);
}

/** Answers use displayed units; only generated Recipe values use storage units. */
export function validateAnswer(param: Parameter, value: unknown): Answer {
  const fail = (reason: string): never => {
    throw new Error(`${param.key}: ${reason}`);
  };
  if (param.type === 'bool')
    return typeof value === 'boolean' ? value : fail('expected a boolean');
  if (param.type === 'list') {
    if (
      !Array.isArray(value) ||
      !value.every(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0,
      )
    )
      return fail('expected a list of task IDs');
    if (new Set(value).size !== value.length)
      return fail('task IDs must be unique');
    if (value.length < (param.min ?? 0))
      return fail(`expected at least ${param.min} task IDs`);
    return value;
  }
  if (param.type === 'int' || param.type === 'duration') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      return fail('expected a finite number');
    if (param.type === 'int' && !Number.isSafeInteger(value))
      return fail('expected a safe integer');
    if (param.min !== undefined && value < param.min)
      return fail(`minimum is ${param.min}`);
    if (param.max !== undefined && value > param.max)
      return fail(`maximum is ${param.max}`);
    if (
      param.type === 'duration' &&
      (!Number.isSafeInteger(value * ratio(param)) ||
        value <= 0 ||
        value * ratio(param) >
          (param.store === 'ms' ? 2147483647 : Number.MAX_SAFE_INTEGER))
    )
      return fail(
        'duration must convert to a positive integer within the timer limit',
      );
    return value;
  }
  if (typeof value !== 'string' || !value.trim())
    return fail('expected a nonempty string');
  if (param.type === 'enum' && !param.options?.includes(value))
    return fail(`choose one of ${param.options?.join(', ')}`);
  return value;
}

export function defaults(template: Template): Record<string, Answer> {
  return Object.fromEntries(
    template.params.map((param) => {
      const raw = atPath(template.recipe, param.path);
      return [
        param.key,
        validateAnswer(
          param,
          param.type === 'duration' && typeof raw === 'number'
            ? raw / ratio(param)
            : raw,
        ),
      ];
    }),
  );
}

export async function loadTemplates(root: string): Promise<Template[]> {
  return Promise.all(
    Object.entries(templates).map(async ([name, manifestPath]) => {
      const { manifest: raw, file } = await loadManifest(root, name);
      const recipe = await readRecipe(file);
      const params = raw.groups.flatMap((group) => group.params);
      if (
        new Set(params.map((param) => param.key)).size !== params.length ||
        new Set(params.map((param) => param.path)).size !== params.length
      )
        throw new Error(`${manifestPath}: duplicate parameter key or path`);
      for (const param of params) {
        atPath(recipe, param.path);
        if (param.type === 'duration') ratio(param);
        if (param.type === 'enum' && !param.options)
          throw new Error(`${param.key}: enum requires options`);
      }
      for (const keys of raw.disjoint ?? [])
        for (const key of keys) {
          if (
            !params.some((param) => param.key === key && param.type === 'list')
          )
            throw new Error(
              `${manifestPath}: disjoint references unknown list ${key}`,
            );
        }
      for (const key of raw.estimate?.parameters ?? [])
        if (
          !params.some(
            (param) =>
              param.key === key && ['int', 'list'].includes(param.type),
          )
        )
          throw new Error(
            `${manifestPath}: estimate references unknown integer or list ${key}`,
          );
      const template = { name, file, manifest: raw, recipe, params };
      applyAnswers(template, {});
      return template;
    }),
  );
}

export async function readAnswers(file: string): Promise<Answers> {
  const raw = await readYaml(file);
  if (!validateAnswers(raw))
    throw new Error(`Answers: ${ajv.errorsText(validateAnswers.errors)}`);
  return raw;
}

export function applyAnswers(
  template: Template,
  overrides: Record<string, Answer>,
): { recipe: Recipe; values: Record<string, Answer>; answers: Answers } {
  const recipe = structuredClone(template.recipe);
  const values = defaults(template);
  const changed: Record<string, Answer> = {};
  for (const [key, raw] of Object.entries(overrides)) {
    const param = template.params.find((entry) => entry.key === key);
    if (!param) throw new Error(`Unknown answer: ${key}`);
    const value = validateAnswer(param, raw);
    if (JSON.stringify(value) !== JSON.stringify(values[key]))
      changed[key] = value;
    values[key] = value;
    const parts = param.path.split('.');
    const leaf = parts.pop()!;
    const parent = object(atPath(recipe, parts.join('.')), param.path);
    parent[leaf] =
      param.type === 'duration' && typeof value === 'number'
        ? value * ratio(param)
        : value;
  }
  for (const keys of template.manifest.disjoint ?? []) {
    const seen = new Set<string>();
    for (const key of keys) {
      const items = values[key];
      if (!Array.isArray(items)) throw new Error(`${key}: expected task IDs`);
      for (const task of items) {
        if (seen.has(task))
          throw new Error(`Task splits must not overlap: ${task}`);
        seen.add(task);
      }
    }
  }
  if (/REPLACE_WITH_[A-Z0-9_]+/.test(JSON.stringify(recipe)))
    throw new Error(
      'Replace REPLACE_WITH_* placeholders in the source Recipe before launching.',
    );
  return {
    recipe,
    values,
    answers: {
      schemaVersion: 'rsi.launch.answers/v1',
      template: template.name,
      values: changed,
    },
  };
}

export async function parseInput(
  param: Parameter,
  text: string,
): Promise<Answer> {
  let raw: unknown = text.trim();
  if (param.type === 'list') {
    const contents = text.trim().startsWith('@')
      ? await readFile(resolve(text.trim().slice(1)), 'utf8')
      : text;
    raw = /^\s*(\[|-\s)/.test(contents)
      ? parse(contents)
      : contents.split(/[\s,]+/).filter(Boolean);
  } else if (param.type === 'int' || param.type === 'duration')
    raw = text.trim() ? Number(text) : NaN;
  return validateAnswer(param, raw);
}

export function environment(
  template: Pick<Template, 'manifest'>,
  recipe: Recipe,
): EnvironmentVariable[] {
  const entries = new Map(
    template.manifest.env.map((entry) => [entry.name, entry]),
  );
  for (const match of JSON.stringify(recipe).matchAll(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
  )) {
    if (!entries.has(match[1]))
      entries.set(match[1], { name: match[1], label: match[1] });
  }
  return [...entries.values()].map((entry) => ({
    ...entry,
    secret:
      entry.secret || /key|token|secret|password|credential/i.test(entry.name),
  }));
}

export function rewriteRelativePaths(value: Value, directory: string): Value {
  if (typeof value === 'string')
    return /^\.\.?[/\\]/.test(value) ? resolve(directory, value) : value;
  if (Array.isArray(value))
    return value.map((item) => rewriteRelativePaths(item, directory));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        rewriteRelativePaths(item, directory),
      ]),
    );
  return value;
}

export function experimentDirectory(root: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
    throw new Error(
      'Experiment ID must be 1–128 letters, digits, dots, hyphens or underscores, starting with a letter or digit.',
    );
  return join(root, '.rsi', 'launcher', id);
}

/** Exclusive creation prevents a replay from overwriting files needed by resume. */
export async function generate(
  root: string,
  id: string,
  template: Template,
  overrides: Record<string, Answer>,
): Promise<string> {
  const directory = experimentDirectory(root, id);
  const { recipe, answers } = applyAnswers(template, overrides);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  await writeFile(join(directory, 'answers.yaml'), stringify(answers), {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(
    join(directory, 'recipe.yaml'),
    stringify(rewriteRelativePaths(recipe, dirname(template.file))),
    { flag: 'wx', mode: 0o600 },
  );
  return directory;
}
