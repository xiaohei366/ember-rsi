import type { JsonObject, JsonValue } from './json.js';

export type LearningKind = 'memory' | 'reflection';
export type LearningTrigger =
  | { afterStep: string; every?: number; if?: JsonValue }
  | {
      afterIteration: string;
      every?: number;
      skipFinal?: boolean;
      if?: JsonValue;
    }
  | { afterPolicy: true; if?: JsonValue };

export type LearningObserve = {
  bindings?: string[];
  steps?: string[];
  excludeSteps?: string[];
  includeBaseline?: boolean;
  includeCandidateDiffs?: boolean;
  includeCandidateSources?: boolean;
  includeAgentTraces?: boolean;
  includeDocumentPreviews?: boolean;
  includeRevisionComparisons?: boolean;
};

export type LearningBudget = {
  modelCalls?: number;
  timeoutSeconds?: number;
  evidenceBytes?: number;
};

export type LearningModuleBase = {
  enabled?: boolean;
  trigger?: LearningTrigger | LearningTrigger[];
  observe?: LearningObserve;
  evidenceView?: 'execution' | 'training-summary';
  goal?: string;
  goalFile?: string;
  plugin?: string;
  config?: JsonObject;
  budget?: LearningBudget;
};

export type MemoryDeclaration = LearningModuleBase & {
  consumers?: string[];
  editConstraints?: {
    allowedPaths?: string[];
    maxChangedFiles?: number;
    maxChangedBytes?: number;
  };
  seed?:
    | { directory: string; fromExperiment?: never }
    | { fromExperiment: string; directory?: never };
};

export type ReflectionDeclaration = LearningModuleBase & {
  targets?: Record<string, { resources: string[] }>;
};

const name = { type: 'string', minLength: 1, pattern: '\\S' };
const names = { type: 'array', uniqueItems: true, items: name };
const nonnegative = {
  type: 'integer',
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
};
const every = { ...nonnegative, minimum: 1 };
export const learningTriggerSchema: JsonObject = {
  oneOf: [
    {
      type: 'object',
      properties: { afterStep: name, every, if: {} },
      required: ['afterStep'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        afterIteration: name,
        every,
        skipFinal: { type: 'boolean' },
        if: {},
      },
      required: ['afterIteration'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { afterPolicy: { const: true }, if: {} },
      required: ['afterPolicy'],
      additionalProperties: false,
    },
  ],
};
const triggerArray = {
  type: 'array',
  minItems: 1,
  items: learningTriggerSchema,
};
const common = {
  enabled: { type: 'boolean' },
  trigger: { oneOf: [learningTriggerSchema, triggerArray] },
  observe: {
    type: 'object',
    properties: {
      bindings: names,
      steps: names,
      excludeSteps: names,
      ...Object.fromEntries(
        [
          'includeBaseline',
          'includeCandidateDiffs',
          'includeCandidateSources',
          'includeAgentTraces',
          'includeDocumentPreviews',
          'includeRevisionComparisons',
        ].map((key) => [key, { type: 'boolean' }]),
      ),
    },
    additionalProperties: false,
  },
  evidenceView: { enum: ['execution', 'training-summary'] },
  goal: name,
  goalFile: { ...name, 'x-rsi-path': 'file' },
  plugin: name,
  config: { type: 'object' },
  budget: {
    type: 'object',
    properties: {
      modelCalls: nonnegative,
      timeoutSeconds: { ...every, maximum: Math.floor(2147483647 / 1000) },
      evidenceBytes: every,
    },
    additionalProperties: false,
  },
};
const moduleSchema = {
  type: 'object',
  not: { required: ['goal', 'goalFile'] },
  additionalProperties: false,
};
export const learningDeclarationSchemas: Record<LearningKind, JsonObject> = {
  memory: {
    ...moduleSchema,
    properties: {
      ...common,
      consumers: { ...names, minItems: 1 },
      editConstraints: {
        type: 'object',
        properties: {
          allowedPaths: names,
          maxChangedFiles: nonnegative,
          maxChangedBytes: nonnegative,
        },
        additionalProperties: false,
      },
      seed: {
        oneOf: [
          {
            type: 'object',
            properties: { directory: { ...name, 'x-rsi-path': 'directory' } },
            required: ['directory'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { fromExperiment: name },
            required: ['fromExperiment'],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  reflection: {
    ...moduleSchema,
    properties: {
      ...common,
      targets: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: { resources: { ...names, minItems: 1 } },
          required: ['resources'],
          additionalProperties: false,
        },
      },
    },
  },
};
