import type {
  JsonObject,
  JsonSchema,
  PluginContract,
} from '../../contracts/index.js';
import { scopeRoots, validateTemplate, type Scope } from './scope.js';
import type { Step, StepValidationContext, Template } from '../policy/steps.js';
import {
  snapshotScope,
  type FlowIndex,
  type StepLocation,
} from '../learning/trigger.js';

export function compileFlow(policy: {
  inputDefaults: JsonObject;
  stateInitial: JsonObject;
  stateSchema: JsonSchema;
  steps: readonly Step[];
  output: Template;
  requirements: Readonly<Record<string, PluginContract>>;
  defaults: JsonObject;
}): FlowIndex {
  const locations: StepLocation[] = [];
  const base: Scope = {
    names: [...scopeRoots, 'memory'],
    frames: [],
    parallel: false,
    loopDepth: 0,
  };
  validateTemplate(
    policy.inputDefaults,
    { ...base, names: ['application', 'config'] },
    'policy.input',
  );
  validateTemplate(
    policy.stateInitial,
    { ...base, names: ['application', 'config', 'input'] },
    'policy.state',
  );
  function visit(
    steps: readonly Step[],
    scope: Scope,
    label: string,
    output?: Template,
  ): Scope {
    const completed = new Set<string>();
    const local = {
      ...scope,
      frames: [
        ...scope.frames,
        { declared: new Set(steps.map((step) => step.id)), completed },
      ],
    };
    for (const step of steps) {
      let iterationScope: Scope | undefined;
      const context: StepValidationContext = {
        label: `${label}/${step.id}`,
        requirements: policy.requirements,
        stateSchema: policy.stateSchema,
        parallel: local.parallel,
        loopDepth: local.loopDepth,
        names: local.names,
        validateTemplate(template, locals = [], allowMemory = true) {
          validateTemplate(
            template,
            allowMemory
              ? local
              : {
                  ...local,
                  names: local.names.filter((name) => name !== 'memory'),
                },
            this.label,
            locals,
          );
        },
        validateSteps(children, options) {
          const childScope = visit(
            children,
            {
              ...local,
              names: [...local.names, ...(options.locals ?? [])],
              parallel: local.parallel || (options.parallel ?? false),
              loopDepth: options.loopDepth ?? local.loopDepth,
            },
            options.scope === 'then' || options.scope === 'else'
              ? `${this.label}/${options.scope}/steps`
              : `${this.label}/steps`,
            options.output,
          );
          if (options.scope === 'iteration') iterationScope = childScope;
        },
      };
      step.validate(context);
      if (step.type !== 'control') completed.add(step.id);
      locations.push({
        step,
        location: context.label,
        postScope: snapshotScope(local),
        iterationScope,
      });
    }
    if (output !== undefined)
      validateTemplate(output, local, `${label}.output`);
    return snapshotScope(local);
  }
  return {
    locations,
    rootScope: visit(policy.steps, base, 'steps', policy.output),
  };
}
