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
  const repairAuthorized =
    state.phase === 'paused' && state.issues.at(-1)?.decision === 'repair';
  if (repairAuthorized) return undefined;
  if (state.phase !== 'running')
    return 'Acceptance is paused/stopped. Use safe browser diagnostics and request an operator decision before local execution or edits.';
  // Routine local execution is covered by run authorization. This is a trusted
  // agent policy, not a shell sandbox; source changes and destructive operations
  // through a shell still require a specific operator-approved proposal.
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
  return 'Source changes require a paused issue, a concrete proposal, and explicit operator repair approval. Temporary .mjs steps may be created or edited under /tmp/soms-browser-e2e/steps/.';
}
