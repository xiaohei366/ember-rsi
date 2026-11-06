import type { JsonSchema } from '../../contracts/index.js';

export type HumanReviewConfig = {
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
};

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    waitTimeoutMs: { type: 'integer', minimum: 1, default: 86400000 },
    pollIntervalMs: { type: 'integer', minimum: 1, default: 250 },
  },
  additionalProperties: false,
};
