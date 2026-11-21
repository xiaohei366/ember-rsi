import type { JsonObject, JsonValue } from '../../contracts/json.js';
import {
  learningDeclarationSchemas,
  learningTriggerSchema,
  type LearningKind,
  type LearningObserve,
  type LearningTrigger,
  type MemoryDeclaration,
  type ReflectionDeclaration,
} from '../../contracts/learning.js';
import { object } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';

export type {
  LearningKind,
  LearningTrigger,
  LearningObserve,
} from '../../contracts/learning.js';

type LearningConfig = {
  digest: string;
  goal: string;
  goalFile?: string;
  plugin: string;
  config: JsonObject;
  observe: LearningObserve;
  trigger: LearningTrigger[];
  evidenceView: 'execution' | 'training-summary';
  budget: {
    modelCalls?: number;
    elapsedWallMs?: number;
    evidenceBytes?: number;
  };
};
export type MemoryConfig = LearningConfig &
  Pick<MemoryDeclaration, 'seed' | 'editConstraints'> & {
    consumers: string[];
    seedArtifactRef?: string;
  };
export type ReflectionConfig = LearningConfig & {
  targets: NonNullable<ReflectionDeclaration['targets']>;
};

/** Locked configs contain absolute resource paths and decoded goal text. Recovery never rereads declarations. */
export function parseLockedConfig(kind: 'memory', raw: JsonValue): MemoryConfig;
export function parseLockedConfig(
  kind: 'reflection',
  raw: JsonValue,
): ReflectionConfig;
export function parseLockedConfig(
  kind: LearningKind,
  raw: JsonValue,
): MemoryConfig | ReflectionConfig {
  const properties = object(learningDeclarationSchemas[kind].properties);
  const { enabled: _enabled, ...declaration } = properties;
  const { timeoutSeconds: _seconds, ...budget } = object(
    object(properties.budget).properties,
  );
  validate(
    {
      type: 'object',
      additionalProperties: false,
      required: [
        'plugin',
        'config',
        'goal',
        'trigger',
        'observe',
        'evidenceView',
        'budget',
        'digest',
        kind === 'memory' ? 'consumers' : 'targets',
      ],
      properties: {
        ...declaration,
        digest: { type: 'string', minLength: 1 },
        trigger: { type: 'array', minItems: 1, items: learningTriggerSchema },
        budget: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...budget,
            elapsedWallMs: { type: 'integer', minimum: 1, maximum: 2147483647 },
          },
        },
        ...(kind === 'memory'
          ? { seedArtifactRef: { type: 'string', minLength: 1 } }
          : {}),
      },
    },
    raw,
    `locked ${kind}`,
  );
  return raw as MemoryConfig | ReflectionConfig;
}
