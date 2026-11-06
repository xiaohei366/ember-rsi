import type { JsonObject } from '../../contracts/index.js';

/** Settings are supplied by the Policy step so one binding can run configured experiments. */
export const configSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
};
