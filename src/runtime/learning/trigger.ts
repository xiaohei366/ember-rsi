import type { LearningTrigger } from '../../contracts/learning.js';
import { validateTemplate, type Scope } from '../compiler/scope.js';
import type { Step } from '../policy/steps.js';

export interface StepLocation {
  step: Step;
  location: string;
  postScope: Scope;
  /** Scope after running the loop body, with its local outputs and loop.index. */
  iterationScope?: Scope;
}

export interface FlowIndex {
  locations: readonly StepLocation[];
  rootScope: Scope;
}

/** Lexical scope frames grow during compilation. Each boundary needs its own completed prefix. */
export function snapshotScope(scope: Scope): Scope {
  return {
    ...scope,
    frames: scope.frames.map((frame) => ({
      declared: frame.declared,
      completed: new Set(frame.completed),
    })),
  };
}

export function resolveTriggerTarget(
  index: FlowIndex,
  selector: string,
): StepLocation {
  const exact = index.locations.find((entry) => entry.location === selector);
  if (exact) return exact;
  const matches = index.locations.filter(
    ({ step, location }) =>
      step.id === selector ||
      ('/' + location.replaceAll('/steps/', '/').slice(6)).endsWith(
        '/' + selector,
      ),
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? `Ambiguous learning step ${selector}: ${matches.map((entry) => entry.location).join(', ')}`
        : `Unknown learning step ${selector}`,
    );
  return matches[0]!;
}

export function compileTrigger(
  trigger: LearningTrigger,
  index: FlowIndex,
): LearningTrigger {
  if ('afterPolicy' in trigger) {
    if (trigger.if !== undefined)
      validateTemplate(trigger.if, index.rootScope, 'afterPolicy.if');
    return trigger;
  }
  const iteration = 'afterIteration' in trigger;
  const target = resolveTriggerTarget(
    index,
    iteration ? trigger.afterIteration : trigger.afterStep,
  );
  if (target.postScope.parallel)
    throw new Error(
      `Learning trigger at ${target.location} cannot run in a parallel foreach`,
    );
  if (iteration && !target.iterationScope)
    throw new Error(`afterIteration at ${target.location} requires a loop`);
  if (trigger.if !== undefined)
    validateTemplate(
      trigger.if,
      iteration ? target.iterationScope! : target.postScope,
      `${target.location}.trigger.if`,
    );
  return iteration
    ? { ...trigger, afterIteration: target.location }
    : { ...trigger, afterStep: target.location };
}

/** Match a canonical AST location, preserving IDs even when they resemble runtime path segments. */
export function matchesStepPath(path: string, location: string): boolean {
  const stable = path.split('/');
  const parts = location.split('/');
  let cursor = 0;
  for (let index = 0; index < parts.length; ) {
    if (
      parts[index++] !== 'steps' ||
      (cursor === 0 && stable[cursor++] !== 'steps')
    )
      return false;
    if (parts[index++] !== stable[cursor++]) return false;
    if (index === parts.length) break;
    if (parts[index] === 'then' || parts[index] === 'else') {
      if (stable[cursor++] !== parts[index++]) return false;
    } else if (
      !/^(?:iteration-\d+|key-[a-f0-9]{64})$/.test(stable[cursor++] ?? '')
    )
      return false;
  }
  return cursor === stable.length;
}
