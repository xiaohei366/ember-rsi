import type { OperationDefinition } from '../../contracts/index.js';
import {
  humanReviewContract,
  type HumanReviewInput,
  type HumanReviewOutput,
} from '../../contracts/plugin-types/human-review.js';
import { configSchema, type HumanReviewConfig } from './schema.js';
import { createHumanReview } from './service.js';

export const humanReviewDefinition: OperationDefinition<
  HumanReviewInput,
  HumanReviewOutput,
  HumanReviewConfig
> = {
  id: 'human.review',
  description:
    'Wait for request-bound human feedback without extending the RSI CLI.',
  contract: humanReviewContract,
  configSchema,
  create: createHumanReview,
};
