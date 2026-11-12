import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { RunState } from '../../../test/browser-e2e/infrastructure/acceptance-run.mjs';

// Extension lifecycle policy belongs in the reloaded TypeScript graph rather
// than a native ESM helper that can retain an older export set across /reload.
export function localOperationBlockReason(
  state: RunState | undefined,
  tool: string,
  path?: unknown,
): string | undefined {
  if (!state || !['bash', 'edit', 'write'].includes(tool)) return undefined;
  if (state.phase !== 'running')
    return 'Acceptance is paused/stopped. Use safe browser diagnostics and request an operator decision before local execution or edits.';
  // The operator's continue approval also approves a repair proposal recorded
  // on the current issue; that authorization ends at the next pause.
  const issue = state.issues.at(-1);
  if (issue?.decision === 'continue' && issue.proposal?.trim())
    return undefined;
  // Routine local execution is covered by run authorization. This is a trusted
  // agent policy, not a shell sandbox; source changes and destructive operations
  // through a shell still require a paused issue with a concrete proposal and
  // the operator's continue approval.
  if (tool === 'bash') return undefined;
  if (typeof path === 'string' && path.endsWith('.mjs')) {
    const child = relative('/tmp/soms-browser-e2e/steps', resolve(path));
    if (
      child &&
      child !== '..' &&
      !child.startsWith(`..${sep}`) &&
      !isAbsolute(child)
    )
      return undefined;
  }
  return 'Source changes require a paused issue with a concrete proposal and operator continue approval. Temporary .mjs steps may be created or edited under /tmp/soms-browser-e2e/steps/.';
}
