import type {
  OperationDefinition,
  ProposerInput,
  ProposerOutput,
} from '../../contracts/index.js';
import { proposerContract } from '../../contracts/plugin-types/proposer.js';
import { configSchema, type SkillProposerConfig } from './schema.js';
import { createProposerSkill } from './service.js';

export const proposerSkillDefinition: OperationDefinition<
  ProposerInput,
  ProposerOutput,
  SkillProposerConfig
> = {
  id: 'proposer.skill',
  description:
    'Improve RSI skill documentation from approved development feedback.',
  contract: proposerContract,
  configSchema,
  create: createProposerSkill,
};
