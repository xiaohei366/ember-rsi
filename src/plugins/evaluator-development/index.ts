import type { OperationDefinition } from '../../contracts/index.js';
import {
  developmentContract,
  type DevelopmentInput,
  type DevelopmentOutput,
} from '../../contracts/plugin-types/development.js';
import { configSchema, type DevelopmentConfig } from './schema.js';
import { createDevelopmentEvaluator } from './service.js';

export const developmentEvaluatorDefinition: OperationDefinition<
  DevelopmentInput,
  DevelopmentOutput,
  DevelopmentConfig
> = {
  id: 'evaluator.development',
  description:
    'Evaluate fresh skill-guided repository development and independently accept its delivery.',
  contract: developmentContract,
  configSchema,
  create: createDevelopmentEvaluator,
};
