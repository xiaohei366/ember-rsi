import { defineContract } from '../contract.js';
import { recordSchema } from '../models/measurement.js';

export type DevelopmentOutcome =
  | 'automatic-pass'
  | 'development-failure'
  | 'environment-failure'
  | 'uncertain-failure';
export type DevelopmentInput =
  | { action: 'preflight'; candidateRef: string }
  | {
      action: 'evaluate';
      candidateRef: string;
      attempt: number;
      acceptanceIssues: string[];
    }
  | {
      action: 'export';
      candidateRef: string;
      reportRef: string;
      reviewRef: string;
    };
export type DevelopmentOutput =
  | { action: 'preflight'; ready: boolean; reportRef: string }
  | {
      action: 'evaluate';
      attemptId: string;
      candidateRef: string;
      outcome: DevelopmentOutcome;
      reportRef: string;
    }
  | { action: 'export'; packageRef: string };

const text = { type: 'string', minLength: 1 };
export const developmentContract = defineContract({
  id: 'contract.development',
  input_schema: {
    oneOf: [
      recordSchema({ action: { const: 'preflight' }, candidateRef: text }),
      recordSchema({
        action: { const: 'evaluate' },
        candidateRef: text,
        attempt: { type: 'integer', minimum: 1 },
        acceptanceIssues: { type: 'array', items: text },
      }),
      recordSchema({
        action: { const: 'export' },
        candidateRef: text,
        reportRef: text,
        reviewRef: text,
      }),
    ],
  },
  output_schema: {
    oneOf: [
      recordSchema({
        action: { const: 'preflight' },
        ready: { type: 'boolean' },
        reportRef: text,
      }),
      recordSchema({
        action: { const: 'evaluate' },
        attemptId: text,
        candidateRef: text,
        outcome: {
          enum: [
            'automatic-pass',
            'development-failure',
            'environment-failure',
            'uncertain-failure',
          ],
        },
        reportRef: text,
      }),
      recordSchema({ action: { const: 'export' }, packageRef: text }),
    ],
  },
});
