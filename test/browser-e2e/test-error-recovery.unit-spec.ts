import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertBrowserAction,
  loadRun,
  pauseRun,
  saveRun,
  type RunState,
} from './infrastructure/acceptance-run.mjs';
import { localOperationBlockReason } from '../../tools/pi-web-testing/extension/local-operation-policy';
import {
  isTemporaryStep,
  recoverTestError,
} from '../../tools/pi-web-testing/extension/test-error-recovery';

const path = '/tmp/soms-browser-e2e/steps/create-users.mjs';
function pending(): RunState {
  const state: RunState = {
    version: 1,
    id: '1792846998551-7b02af8e-e09f-4f9e-9594-8fcb2174eb5c',
    mode: 'quick',
    nodes: {
      alpha: {
        edge: 'https://alpha.test/',
        admin: 'https://alpha.test/admin/',
        service: 'https://alpha.test/',
        domain: 'alpha.test',
      },
      bravo: {
        edge: 'https://bravo.test/',
        admin: 'https://bravo.test/admin/',
        service: 'https://bravo.test/',
        domain: 'bravo.test',
      },
    },
    phase: 'running',
    createdAt: new Date().toISOString(),
    cases: [
      {
        id: 'Q0.create',
        title: 'Create user',
        outcome: 'NOT RUN',
        evidence: '',
      },
    ],
    issues: [],
    next: '',
  };
  pauseRun(state, {
    kind: 'UNCLASSIFIED',
    summary: 'Browser command failed; classify before continuing',
    evidence: 'Missing temporary-step locator #cu-name',
    failureSource: 'browser-command',
  });
  return state;
}
const diagnosis = {
  id: 'issue-1',
  scope: 'temporary-step',
  path,
  evidence:
    'Visible form has only account input; remove the nonexistent display-name locator from the temporary script.',
};

describe('routine acceptance test-error recovery', () => {
  it('retains failure and diagnosis, resumes without PASS or source authorization', () => {
    const state = pending();
    expect(() => assertBrowserAction(state, 'eval')).toThrow();
    recoverTestError(state, diagnosis);
    expect(state.phase).toBe('running');
    expect(state.issues[0]).toMatchObject({
      kind: 'DRIVER_MISMATCH',
      decision: 'agent-retry',
      recovery: { scope: 'temporary-step', path },
    });
    expect(state.issues[0].evidence).toContain(
      'Missing temporary-step locator',
    );
    expect(state.issues[0].evidence).toContain(diagnosis.evidence);
    expect(state.cases[0].outcome).toBe('NOT RUN');
    expect(() => assertBrowserAction(state, 'eval')).not.toThrow();
    expect(localOperationBlockReason(state, 'edit', path)).toBeUndefined();
    for (const source of [
      'test/browser-e2e/driver.mjs',
      'src/user/user.service.ts',
      'test/browser-e2e/steps/ui-fixtures.mjs',
    ])
      expect(localOperationBlockReason(state, 'edit', source)).toContain(
        'Source changes require',
      );
    expect(() => recoverTestError(state, diagnosis)).toThrow();
  });

  it('allows argument correction without authorizing a file', () => {
    const state = pending();
    recoverTestError(state, {
      id: 'issue-1',
      scope: 'arguments',
      evidence:
        'Login helper requires explicit node alpha; retry with node alpha.',
    });
    expect(state.issues[0].recovery).toEqual({ scope: 'arguments' });
  });

  it.each(['PRODUCT_BUG', 'ENVIRONMENT', 'DRIVER_MISMATCH'] as const)(
    'cannot resume a classified %s pause',
    (kind) => {
      const state = pending();
      state.issues[0].kind = kind;
      const before = structuredClone(state);
      expect(() => recoverTestError(state, diagnosis)).toThrow();
      expect(state).toEqual(before);
    },
  );

  it.each(['stopped', 'completed', 'running'] as const)(
    'cannot resume %s run',
    (phase) => {
      const state = pending();
      state.phase = phase;
      expect(() => recoverTestError(state, diagnosis)).toThrow();
    },
  );

  it.each(['repair', 'stop', 'skip', 'retry'])(
    'cannot override operator decision %s',
    (decision) => {
      const state = pending();
      state.issues[0].decision = decision;
      expect(() => recoverTestError(state, diagnosis)).toThrow();
    },
  );

  it('cannot resume lifecycle/configuration pauses or legacy unclassified issues', () => {
    const state = pending();
    delete state.issues[0].failureSource;
    expect(() => recoverTestError(state, diagnosis)).toThrow();
  });

  it.each([
    { ...diagnosis, id: 'issue-0' },
    { ...diagnosis, evidence: '  ' },
    { ...diagnosis, scope: 'source' },
    { ...diagnosis, path: 'test/browser-e2e/driver.mjs' },
    { ...diagnosis, path: '/tmp/soms-browser-e2e/steps/../driver.mjs' },
    { ...diagnosis, path: '/tmp/soms-browser-e2e/steps-other/test.mjs' },
    { ...diagnosis, path: undefined },
    { ...diagnosis, scope: 'arguments' },
  ])('rejects invalid recovery atomically: %j', (input) => {
    const state = pending();
    const before = structuredClone(state);
    expect(() => recoverTestError(state, input)).toThrow();
    expect(state).toEqual(before);
  });

  it('persists a distinct agent-retry audit trail across reload', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-error-recovery-'));
    try {
      const state = pending();
      recoverTestError(state, diagnosis);
      saveRun(join(root, state.id), state);
      const restored = loadRun(root, state.id).state;
      expect(restored.issues).toEqual(state.issues);
      expect(restored.phase).toBe('running');
      expect(restored.cases[0].outcome).toBe('NOT RUN');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts only absolute temporary module paths', () => {
    expect(isTemporaryStep(path)).toBe(true);
    for (const input of [
      null,
      '../steps/test.mjs',
      '/tmp/soms-browser-e2e/steps/test.ts',
      '/tmp/soms-browser-e2e/steps.mjs',
    ])
      expect(isTemporaryStep(input)).toBe(false);
  });
});
