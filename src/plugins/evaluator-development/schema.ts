import type { JsonObject, JsonSchema } from '../../contracts/index.js';
import { recordSchema } from '../../contracts/models/measurement.js';

export type DevelopmentConfig = {
  development: {
    sdk: JsonObject;
    taskId: string;
    taskPackage: string;
    baselineDirectory: string;
    taskDirectory: string;
    bundle: string;
    skillPrompt: string;
    deliveryDirectory: string;
  };
  preflight: { sdk: JsonObject; bundle: string };
  acceptance: { recipePath: string; pluginDirectory: string };
  developmentTimeoutMs?: number;
  acceptanceTimeoutMs?: number;
};

const text = { type: 'string', minLength: 1 };
const relativePath = {
  ...text,
  pattern: '^(?![A-Za-z]:)(?!/)(?!.*\\\\)(?!.*(?:^|/)\\.\\.?(?:/|$)).+$',
};
export const configSchema: JsonSchema = recordSchema(
  {
    development: recordSchema({
      sdk: { type: 'object' },
      taskId: text,
      taskPackage: { ...text, 'x-rsi-path': 'directory' },
      baselineDirectory: { ...text, 'x-rsi-path': 'directory' },
      taskDirectory: relativePath,
      bundle: { ...text, 'x-rsi-path': 'directory' },
      skillPrompt: relativePath,
      deliveryDirectory: relativePath,
    }),
    preflight: recordSchema({
      sdk: { type: 'object' },
      bundle: { ...text, 'x-rsi-path': 'directory' },
    }),
    acceptance: recordSchema({
      recipePath: relativePath,
      pluginDirectory: relativePath,
    }),
    developmentTimeoutMs: { type: 'integer', minimum: 1, default: 3600000 },
    acceptanceTimeoutMs: { type: 'integer', minimum: 1, default: 14400000 },
  },
  ['development', 'preflight', 'acceptance'],
);
