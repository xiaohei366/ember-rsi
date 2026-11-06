import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';

export type GepaModule = {
  /** Stable module identity used for rotation and merge bookkeeping. */
  id: string;
  /** Bundle-relative path edited by a mutation or merge. */
  path: string;
};

export type GepaSettings = {
  feedbackTaskIds: string[];
  selectionTaskIds: string[];
  maxRounds: number;
  maxRollouts: number;
  minibatchSize: number;
  paretoSize: number;
  seed: number;
  crossoverEvery: number;
  modules: GepaModule[];
  goal: string;
  evaluatorBinding: string;
  reflectorBinding: string;
  reflectionMaxModelCalls: number;
  maxEvidenceBytes: number;
  editConstraints?: JsonObject;
};

export type GepaOptimizerInput =
  | {
      action: 'initialize';
      candidateRef: string;
      settings: GepaSettings;
    }
  | {
      action: 'step';
      state: JsonObject;
      settings: GepaSettings;
    };

export type GepaOptimizerOutput = {
  state: JsonObject;
  report: JsonObject;
};

const stringArray = (minItems: number): JsonObject => ({
  type: 'array',
  minItems,
  uniqueItems: true,
  items: { type: 'string', minLength: 1 },
});

const settingsSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'feedbackTaskIds',
    'selectionTaskIds',
    'maxRounds',
    'maxRollouts',
    'minibatchSize',
    'paretoSize',
    'seed',
    'crossoverEvery',
    'modules',
    'goal',
    'evaluatorBinding',
    'reflectorBinding',
    'reflectionMaxModelCalls',
    'maxEvidenceBytes',
  ],
  properties: {
    feedbackTaskIds: stringArray(1),
    selectionTaskIds: stringArray(1),
    maxRounds: { type: 'integer', minimum: 0, maximum: 100000 },
    maxRollouts: { type: 'integer', minimum: 0, maximum: 1000000000 },
    minibatchSize: { type: 'integer', minimum: 1, maximum: 100000 },
    paretoSize: { type: 'integer', minimum: 1, maximum: 100000 },
    seed: { type: 'integer', minimum: 0, maximum: 2147483647 },
    crossoverEvery: { type: 'integer', minimum: 0, maximum: 100000 },
    modules: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'path'],
        properties: {
          id: { type: 'string', minLength: 1 },
          path: { type: 'string', minLength: 1 },
        },
      },
    },
    goal: { type: 'string', minLength: 1 },
    evaluatorBinding: { type: 'string', minLength: 1 },
    reflectorBinding: { type: 'string', minLength: 1 },
    reflectionMaxModelCalls: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
    },
    maxEvidenceBytes: {
      type: 'integer',
      minimum: 256,
      maximum: 2097152,
    },
    editConstraints: { type: 'object' },
  },
};

const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const nonnegativeInteger = { type: 'integer', minimum: 0 };

export const gepaStateSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'seed',
    'rng',
    'feedbackTaskIds',
    'selectionTaskIds',
    'selectionTruncated',
    'baselineCandidateRef',
    'evaluationRefs',
    'selectionConditions',
    'candidates',
    'moduleCursor',
    'completedRounds',
    'rolloutsUsed',
    'mergeAttempts',
    'rounds',
    'bestCandidateRef',
    'bestAggregateScore',
    'done',
    'stopReason',
    'datasetDegenerate',
    'weightsChanged',
  ],
  properties: {
    schemaVersion: { const: 'gepa.state/v1' },
    seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
    rng: { type: 'integer', minimum: 0, maximum: 4294967295 },
    feedbackTaskIds: stringArray(1),
    selectionTaskIds: stringArray(0),
    selectionTruncated: { type: 'boolean' },
    baselineCandidateRef: nullableString,
    evaluationRefs: { type: 'object', additionalProperties: nullableString },
    selectionConditions: {
      type: 'object',
      additionalProperties: nullableString,
    },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'ref',
          'artifactRef',
          'applicationParentRef',
          'parents',
          'ancestors',
          'origin',
          'createdRound',
          'scores',
          'aggregate',
          'aggregateComplete',
          'moduleIds',
        ],
        properties: {
          ref: { type: 'string', minLength: 1 },
          artifactRef: { type: 'string', minLength: 1 },
          applicationParentRef: nullableString,
          parents: stringArray(0),
          ancestors: stringArray(0),
          origin: { enum: ['base', 'mutation', 'crossover'] },
          createdRound: nonnegativeInteger,
          scores: { type: 'object', additionalProperties: nullableNumber },
          aggregate: nullableNumber,
          aggregateComplete: { type: 'boolean' },
          moduleIds: stringArray(1),
        },
      },
    },
    moduleCursor: nonnegativeInteger,
    completedRounds: nonnegativeInteger,
    rolloutsUsed: nonnegativeInteger,
    mergeAttempts: stringArray(0),
    rounds: { type: 'array', items: { type: 'object' } },
    bestCandidateRef: nullableString,
    bestAggregateScore: nullableNumber,
    done: { type: 'boolean' },
    stopReason: nullableString,
    datasetDegenerate: { type: 'boolean' },
    weightsChanged: { const: false },
  },
};
const reportSchema: JsonObject = { type: 'object' };

export const gepaOptimizerContract = defineContract({
  id: 'contract.gepa-optimizer',
  input_schema: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'candidateRef', 'settings'],
        properties: {
          action: { const: 'initialize' },
          candidateRef: { type: 'string', minLength: 1 },
          settings: settingsSchema,
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'state', 'settings'],
        properties: {
          action: { const: 'step' },
          state: gepaStateSchema,
          settings: settingsSchema,
        },
      },
    ],
  },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['state', 'report'],
    properties: {
      state: gepaStateSchema,
      report: reportSchema,
    },
  },
});
