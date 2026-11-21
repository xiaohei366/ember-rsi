import type { JsonObject } from '../json.js';
import { defineContract } from '../contract.js';

export type MemoryInput = {
  /** Immutable file-tree artifact for the active Memory, or null on the first invocation. */
  memoryRef: string | null;
  goal: string;
  /** References to Runtime-prepared learning evidence snapshots. */
  evidenceRefs: string[];
  editConstraints: JsonObject;
};

export type MemoryOutput =
  | {
      status: 'proposed';
      resourceRef: string;
      changeRef: string;
      reason: string;
    }
  | { status: 'no-change'; resourceRef: null; changeRef: null; reason: string };

const reference = { type: 'string', minLength: 1 };

export const memoryContract = defineContract({
  id: 'contract.memory',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['memoryRef', 'goal', 'evidenceRefs', 'editConstraints'],
    properties: {
      memoryRef: { anyOf: [reference, { type: 'null' }] },
      goal: { type: 'string', minLength: 1 },
      evidenceRefs: { type: 'array', items: reference },
      editConstraints: { type: 'object' },
    },
  },
  output_schema: {
    oneOf: ['proposed', 'no-change'].map((status) => {
      const ref = status === 'proposed' ? reference : { type: 'null' };
      return {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'resourceRef', 'changeRef', 'reason'],
        properties: {
          status: { const: status },
          resourceRef: ref,
          changeRef: ref,
          reason: { type: 'string' },
        },
      };
    }),
  },
});
