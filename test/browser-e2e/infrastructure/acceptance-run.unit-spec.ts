import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertBrowserAction,
  createRun,
  decideRun,
  endpoint,
  finishRun,
  loadRun,
  pauseRun,
  recordCase,
  saveRun,
  validateDeployment,
  type RunState,
} from './acceptance-run.mjs';
import { navigationUrl } from './targets.mjs';
import { otpKey, redactSecrets } from './driver-secrets.mjs';

const nodes = {
  alpha: {
    edge: 'https://a.test/',
    admin: 'https://admin-a.test/admin/',
    service: 'https://api-a.test/',
    domain: 'identity-a.test',
  },
  bravo: {
    edge: 'https://b.test/',
    admin: 'https://admin-b.test/admin/',
    service: 'https://api-b.test/',
    domain: 'identity-b.test',
  },
};

describe('acceptance run configuration and gates', () => {
  it('requires two quick nodes and three full nodes without guessing identity domains', () => {
    expect(validateDeployment('quick', nodes).alpha.domain).toBe(
      'identity-a.test',
    );
    expect(validateDeployment('quick', nodes).alpha.account).toBe('admin');
    expect(() => validateDeployment('full', nodes)).toThrow('3 nodes');
    expect(
      Object.keys(
        validateDeployment('full', {
          ...nodes,
          charlie: {
            edge: 'https://c.test/',
            admin: 'https://c.test/admin/',
            service: 'https://api-c.test/',
            domain: 'identity-c.test',
          },
        }),
      ),
    ).toHaveLength(3);
    expect(() =>
      validateDeployment('quick', { ...nodes, charlie: nodes.alpha }),
    ).toThrow('2 nodes');
    expect(() =>
      validateDeployment('quick', { ...nodes, bravo: nodes.alpha }),
    ).toThrow('distinct');
    expect(() =>
      validateDeployment('quick', {
        ...nodes,
        alpha: { ...nodes.alpha, domain: '' },
      }),
    ).toThrow('identity domain');
    for (const url of [
      'https://u:p@a.test',
      'file:///tmp/test',
      'https://a.test/?password=x',
      'https://a.test/#token',
    ])
      expect(() => endpoint(url)).toThrow();
  });
  it('allows only configured browser/admin origins, not backend or lookalike URLs', () => {
    const configured = validateDeployment('quick', nodes);
    expect(navigationUrl('federation', 'alpha', undefined, configured)).toBe(
      nodes.alpha.edge,
    );
    expect(
      navigationUrl('federation', undefined, nodes.alpha.admin, configured),
    ).toBe(nodes.alpha.admin);
    for (const url of [
      'https://a.test.evil/',
      nodes.alpha.service,
      'https://user:pass@a.test/',
    ])
      expect(() =>
        navigationUrl('federation', undefined, url, configured),
      ).toThrow();
    expect(() =>
      navigationUrl('federation', 'charlie', undefined, configured),
    ).toThrow();
    expect(() =>
      navigationUrl('federation', 'alpha', nodes.bravo.edge, configured),
    ).toThrow();
  });
  it('persists progress/issues and stays paused through repair until explicit retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'soms-acceptance-'));
    try {
      const run = createRun(root, 'quick', nodes);
      expect(run.state.cases.every((item) => item.outcome === 'NOT RUN')).toBe(
        true,
      );
      expect(() => finishRun(run.state)).toThrow('Unfinished');
      run.state.checkpoint = 'Fixture alice-alpha retained; cleanup pending.';
      recordCase(run.state, {
        id: 'Q0.login',
        title: 'Login',
        outcome: 'PASS',
        evidence: 'Authenticated identity assertion on both nodes.',
      });
      pauseRun(run.state, {
        kind: 'DRIVER_MISMATCH',
        summary: 'Changed selector',
        evidence: 'Visible form no longer matches selector.',
        proposal: 'Update scoped login selector; run unit checks.',
      });
      expect(() => assertBrowserAction(run.state, 'eval')).toThrow('paused');
      expect(() => assertBrowserAction(run.state, 'open')).toThrow('paused');
      expect(() => assertBrowserAction(run.state, 'shot')).not.toThrow();
      decideRun(run.state, 'repair');
      expect(run.state.phase).toBe('paused');
      expect(() =>
        recordCase(run.state, {
          id: 'Q0',
          title: 'Setup',
          outcome: 'PASS',
          evidence: 'not yet retried',
        }),
      ).toThrow();
      saveRun(run.directory, run.state);
      expect(
        readFileSync(join(run.directory, 'bugs/issue-1.md'), 'utf8'),
      ).toContain('Changed selector');
      expect(
        readFileSync(join(run.directory, 'progress.md'), 'utf8'),
      ).toContain('Q0.login');
      const restored = loadRun(root, run.state.id);
      expect(restored.state.phase).toBe('paused');
      expect(readFileSync(join(run.directory, 'handoff.md'), 'utf8')).toContain(
        'Fixture alice-alpha retained',
      );
      decideRun(restored.state, 'retry');
      expect(() => assertBrowserAction(restored.state, 'eval')).not.toThrow();
      expect(() => loadRun(root, '../../escape')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('BUG and BLOCKED results pause automatically and skipping preserves defect evidence', () => {
    const state: RunState = {
      version: 1,
      id: 'fixture',
      mode: 'quick',
      nodes: {},
      createdAt: '',
      phase: 'running',
      cases: [],
      issues: [],
      next: '',
    };
    recordCase(state, {
      id: 'Q1.bug',
      title: 'Friendship',
      outcome: 'BUG',
      evidence: 'UI action then reproducible peer assertion failure.',
    });
    expect(state.phase).toBe('paused');
    expect(() => decideRun(state, 'repair')).toThrow('proposal');
    expect(state.issues[0].decision).toBeUndefined();
    decideRun(state, 'skip');
    expect(state.cases[0].outcome).toBe('BUG');
    expect(state.issues[0].decision).toBe('skip');
    expect(() =>
      recordCase(state, {
        id: '../bad',
        title: 'Bad',
        outcome: 'PASS',
        evidence: 'bad',
      }),
    ).toThrow();
    expect(() =>
      recordCase(state, {
        id: 'Q2',
        title: 'No evidence',
        outcome: 'PASS',
        evidence: '',
      }),
    ).toThrow();
  });
  it('isolates same-account OTPs by node and redacts secret variants', () => {
    expect(otpKey('alpha', 'alice')).not.toBe(otpKey('bravo', 'alice'));
    expect(otpKey('a:b', 'c')).not.toBe(otpKey('a', 'b:c'));
    const password = 'secret"\\value';
    const text = JSON.stringify({
      password,
      encoded: encodeURIComponent(password),
    });
    expect(redactSecrets(text, [password])).not.toContain('secret');
  });
});
