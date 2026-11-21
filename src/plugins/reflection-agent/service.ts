import { fileURLToPath } from 'node:url';
import type { LearningAgentConfig } from './schema.js';
import type {
  OperationDefinition,
  ReflectionInput,
  ReflectionOutput,
} from '../../contracts/index.js';
import { json, string } from '../../shared/json.js';
import { editResource } from '../shared/agent-editing/index.js';
import { learningContext } from '../shared/agent-editing/learning-context.js';

export const reflectionReviewer = {
  name: 'reflection-reviewer',
  description:
    'Review a focused Reflection question against the authorized workspace evidence.',
  prompt: fileURLToPath(new URL('./reviewer.md', import.meta.url)),
};

export const createReflectionAgent: OperationDefinition<
  ReflectionInput,
  ReflectionOutput,
  LearningAgentConfig
>['create'] = async (config, _context) => {
  return {
    async execute(input, context) {
      json(input);
      const updated = await editResource(
        config,
        input,
        string(input.resourceRef),
        context,
        await learningContext('reflection', input.evidenceRefs, context),
        [reflectionReviewer],
      );
      if (updated.changeRef !== null)
        return {
          status: 'proposed',
          proposal: {
            parentRevisionRefs: input.parentRevisionRefs,
            resourceRef: string(updated.resourceRef),
            changeRef: updated.changeRef,
          },
          reason: updated.reason,
        };
      return {
        status: 'no-change',
        proposal: null,
        reason: updated.reason,
      };
    },
    async dispose() {},
  };
};
