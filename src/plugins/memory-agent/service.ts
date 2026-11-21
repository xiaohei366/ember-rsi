import type { LearningAgentConfig } from './schema.js';
import type {
  MemoryInput,
  MemoryOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { string } from '../../shared/json.js';
import { editResource } from '../shared/agent-editing/index.js';
import { learningContext } from '../shared/agent-editing/learning-context.js';

export const createMemoryAgent: OperationDefinition<
  MemoryInput,
  MemoryOutput,
  LearningAgentConfig
>['create'] = async (config) => ({
  async execute(input, context) {
    const updated = await editResource(
      config,
      input,
      input.memoryRef,
      context,
      await learningContext('memory', input.evidenceRefs, context),
    );
    if (updated.changeRef === null)
      return {
        status: 'no-change',
        resourceRef: null,
        changeRef: null,
        reason: updated.reason,
      };
    return {
      status: 'proposed',
      resourceRef: string(updated.resourceRef),
      changeRef: updated.changeRef,
      reason: updated.reason,
    };
  },
  async dispose() {},
});
