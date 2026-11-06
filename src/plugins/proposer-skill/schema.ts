import type { JsonSchema } from '../../contracts/index.js';
import {
  agentConfigSchema,
  type AgentEditingConfig,
} from '../shared/agent-editing/schema.js';
import { editOutputSchema } from '../shared/agent-editing/index.js';

export type SkillProposerConfig = Omit<
  AgentEditingConfig,
  'prompt' | 'evidenceView'
> & { prompt?: string };

const { evidenceView: _evidenceView, ...properties } =
  agentConfigSchema.properties;

export const configSchema: JsonSchema = {
  type: 'object',
  properties,
  additionalProperties: false,
};

export const proposalSchema: JsonSchema = {
  ...editOutputSchema,
  properties: {
    ...editOutputSchema.properties,
    reason: { type: 'string', minLength: 1 },
    baseCandidateRef: { type: 'string', minLength: 1 },
    baseReason: { type: 'string', minLength: 1 },
  },
  required: [...editOutputSchema.required, 'baseCandidateRef', 'baseReason'],
};

export const skillEditConstraints = {
  allowedPaths: [
    'skills/ember-rsi/SKILL.md',
    'skills/ember-rsi/references/**/*.md',
  ],
};
