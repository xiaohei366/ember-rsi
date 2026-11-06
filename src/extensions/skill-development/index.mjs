import { fileURLToPath } from 'node:url';
import { developmentEvaluatorDefinition } from '../../plugins/evaluator-development/index.js';
import { proposerSkillDefinition } from '../../plugins/proposer-skill/index.js';
import { humanReviewDefinition } from '../../plugins/human-review/index.js';

/** Opt in through --plugin-dir; importing the package does not enable this workflow. */
export function register(registry) {
  for (const definition of [
    developmentEvaluatorDefinition,
    proposerSkillDefinition,
    humanReviewDefinition,
  ])
    registry.registerOperation(definition);
  registry.registerPolicy(
    'policy.skill-development',
    fileURLToPath(
      new URL('../../policies/skill-development/policy.yaml', import.meta.url),
    ),
  );
}
