import {
  readFederationAuditSnapshot,
  waitForFederationConvergence,
} from './final-audit.mjs';
import { compareOperationEffects } from './operation-effects.mjs';

export function assertVerificationMode(mode) {
  if (mode !== 'round' && mode !== 'final')
    throw new Error('--verify-mode must be round or final');
  return mode;
}

export function shouldSettleWorkloadBatch(
  mode,
  batch,
  { randomBatch = false } = {},
) {
  assertVerificationMode(mode);
  if (mode === 'round') return true;
  // Dissolution fanout may continue alongside later random work. Its child tasks
  // and effects are checked by the mandatory final queue barrier and audit.
  const dissolution =
    batch.length > 0 && batch.every(({ type }) => type === 'DISSOLVE_GROUP');
  return !randomBatch && !dissolution;
}

export async function verifyMidpointProfiles(mode, verify) {
  assertVerificationMode(mode);
  // Final-mode observations may still contain viewers whose leave has completed.
  if (mode === 'final') return;
  await verify();
}

/** Observation supplies future choices, but is not an assertion of convergence. */
export async function finishWorkloadBatch(
  { verifyMode = 'round', connections, log, batch, timeoutMs, onProgress },
  {
    observe = readFederationAuditSnapshot,
    converge = waitForFederationConvergence,
    compareEffects = compareOperationEffects,
  } = {},
) {
  assertVerificationMode(verifyMode);
  if (verifyMode === 'final') {
    return observe(connections, log, { readMediaBytes: false });
  }
  const { snapshot } = await converge({
    connections,
    log,
    timeoutMs,
    intervalMs: 500,
    stableSamples: 2,
    enforceCoverage: false,
    validateProfiles: false,
    onProgress,
  });
  const ids = new Set(batch.map(({ id }) => id));
  const effects = compareEffects(
    log.operations.filter(({ id }) => ids.has(id)),
    snapshot,
  );
  if (!effects.passed) {
    const error = new Error(
      'converged operation effects do not match successful commands',
    );
    error.snapshot = snapshot;
    error.comparison = effects;
    throw error;
  }
  return snapshot;
}
