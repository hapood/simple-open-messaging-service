import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { RunState } from '../../../test/browser-e2e/infrastructure/acceptance-run.mjs';

export function isTemporaryStep(path: unknown): path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || !path.endsWith('.mjs'))
    return false;
  const child = relative('/tmp/soms-browser-e2e/steps', resolve(path));
  return (
    !!child &&
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

/** Recover only an undiagnosed command failure, never an operator/product pause. */
export function recoverTestError(
  state: RunState,
  input: { id?: string; scope?: string; path?: string; evidence?: string },
) {
  const issue = state.issues.at(-1);
  if (
    state.phase !== 'paused' ||
    !issue ||
    issue.id !== input.id ||
    issue.kind !== 'UNCLASSIFIED' ||
    issue.failureSource !== 'browser-command' ||
    issue.decision
  )
    throw new Error(
      'Only the current unclassified browser-command failure can be recovered without operator approval.',
    );
  if (!input.evidence?.trim())
    throw new Error(
      'Recovery requires diagnostic evidence and the intended correction.',
    );
  if (!['arguments', 'temporary-step'].includes(input.scope ?? ''))
    throw new Error('Recovery scope must be arguments or temporary-step.');
  if (input.scope === 'temporary-step' && !isTemporaryStep(input.path))
    throw new Error(
      'Temporary-step recovery requires an absolute .mjs path under /tmp/soms-browser-e2e/steps/.',
    );
  if (input.scope === 'arguments' && input.path !== undefined)
    throw new Error('Argument recovery must not authorize file changes.');
  issue.kind = 'DRIVER_MISMATCH';
  issue.evidence += `\n\nAgent test-error diagnosis (${input.scope}${input.path ? `: ${input.path}` : ''}):\n${input.evidence}`;
  issue.recovery = {
    scope: input.scope as 'arguments' | 'temporary-step',
    ...(input.path ? { path: input.path } : {}),
  };
  // Distinguish agent recovery from an explicit operator retry in the audit trail.
  issue.decision = 'agent-retry';
  state.phase = 'running';
  state.next =
    'Correct only the documented temporary step or invocation arguments, verify locally, then rerun the failed assertion. No source changes authorized; no PASS inferred.';
}
