import { defineContract } from '../contract.js';

export type HumanReviewContext = 'implementation' | 'failure' | 'no-change';
export type HumanReviewAction =
  | 'accept'
  | 'continue'
  | 'development-problem'
  | 'retry'
  | 'stop'
  | 'timed-out';

export type HumanReviewInput = {
  attemptId: string;
  candidateRef: string;
  reportRef: string;
  context: HumanReviewContext;
  automaticAccepted: boolean;
  issues: string[];
  skillChangeExplanation?: string;
};

export type HumanReviewOutput = {
  requestId: string;
  feedbackRef: string;
  action: HumanReviewAction;
  issues: string[];
  explanation: string;
};

const text = { type: 'string', minLength: 1 };
const issues = { type: 'array', items: text };

export const humanReviewContract = defineContract({
  id: 'contract.human-review',
  input_schema: {
    type: 'object',
    properties: {
      attemptId: text,
      candidateRef: text,
      reportRef: text,
      context: { enum: ['implementation', 'failure', 'no-change'] },
      automaticAccepted: { type: 'boolean' },
      issues,
      skillChangeExplanation: { type: 'string' },
    },
    required: [
      'attemptId',
      'candidateRef',
      'reportRef',
      'context',
      'automaticAccepted',
      'issues',
    ],
    additionalProperties: false,
  },
  output_schema: {
    type: 'object',
    properties: {
      requestId: text,
      feedbackRef: text,
      action: {
        enum: [
          'accept',
          'continue',
          'development-problem',
          'retry',
          'stop',
          'timed-out',
        ],
      },
      issues,
      explanation: { type: 'string' },
    },
    required: ['requestId', 'feedbackRef', 'action', 'issues', 'explanation'],
    additionalProperties: false,
  },
});
