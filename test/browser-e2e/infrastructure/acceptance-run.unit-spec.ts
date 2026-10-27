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
  registerCases,
  progressSummary,
  roundPrefixOf,
  saveRun,
  validateDeployment,
  deploymentNode,
  resolveDeploymentIdentity,
  type RunState,
} from './acceptance-run.mjs';
import { navigationUrl } from './targets.mjs';
import { localOperationBlockReason } from '../../../tools/pi-web-testing/extension/local-operation-policy';
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
        alpha: { ...nodes.alpha, domain: 'https://not-an-identity.test' },
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
  it('derives endpoints from minimal inputs and discovers identity only after Admin login', () => {
    const alpha = deploymentNode('https://web-a.test');
    const bravo = deploymentNode(
      'https://web-b.test',
      'http://10.0.0.2:3101',
      'operator',
    );
    expect(alpha).toEqual({
      edge: 'https://web-a.test/',
      service: 'https://web-a.test/',
      admin: 'https://web-a.test/admin/',
      account: 'admin',
      domain: '',
    });
    expect(bravo.admin).toBe('http://10.0.0.2:3101/admin/');
    expect(
      deploymentNode('https://web-b.test', 'http://10.0.0.2:3101/admin/').admin,
    ).toBe(bravo.admin);
    const configured = validateDeployment('quick', { alpha, bravo });
    expect(configured.alpha.domain).toBe('');
    expect(
      resolveDeploymentIdentity(configured, 'alpha', 'IDENTITY-A.TEST'),
    ).toBe('identity-a.test');
    expect(() =>
      resolveDeploymentIdentity(configured, 'bravo', 'identity-a.test'),
    ).toThrow('same federation identity');
    expect(configured.bravo.domain).toBe('');
    expect(() => resolveDeploymentIdentity(configured, 'bravo', null)).toThrow(
      'did not report',
    );
    expect(
      resolveDeploymentIdentity(configured, 'bravo', 'identity-b.test'),
    ).toBe('identity-b.test');
    expect(() =>
      resolveDeploymentIdentity(configured, 'alpha', 'changed.test'),
    ).toThrow('identity changed');
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
  it('persists progress/issues and resumes on operator continue', () => {
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
      expect(() => decideRun(run.state, 'repair')).toThrow('Invalid decision');
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
      decideRun(restored.state, 'continue');
      expect(restored.state.phase).toBe('running');
      expect(restored.state.issues[0].decision).toBe('continue');
      expect(restored.state.next).toContain('proposal');
      expect(() => assertBrowserAction(restored.state, 'eval')).not.toThrow();
      expect(() => loadRun(root, '../../escape')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('BUG and BLOCKED results pause automatically and continue preserves defect evidence', () => {
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
    expect(() => decideRun(state, 'skip')).toThrow('Invalid decision');
    expect(state.issues[0].decision).toBeUndefined();
    decideRun(state, 'continue');
    expect(state.phase).toBe('running');
    expect(state.cases[0].outcome).toBe('BUG');
    expect(state.issues[0].decision).toBe('continue');
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
  it('authorizes routine local work once while keeping repair and pause boundaries', () => {
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
    expect(localOperationBlockReason(state, 'bash')).toBeUndefined();
    for (const tool of ['write', 'edit']) {
      expect(
        localOperationBlockReason(
          state,
          tool,
          '/tmp/soms-browser-e2e/steps/scenario.mjs',
        ),
      ).toBeUndefined();
      expect(
        localOperationBlockReason(
          state,
          tool,
          '/tmp/soms-browser-e2e/steps/../driver.mjs',
        ),
      ).toContain('Source changes');
      expect(
        localOperationBlockReason(state, tool, 'test/browser-e2e/driver.mjs'),
      ).toContain('Source changes');
    }
    pauseRun(state, {
      kind: 'DRIVER_MISMATCH',
      summary: 'Stale selector',
      evidence: 'Changed UI',
      proposal: 'Update the scoped driver selector and verify.',
    });
    expect(localOperationBlockReason(state, 'bash')).toContain('paused');
    expect(
      localOperationBlockReason(
        state,
        'edit',
        '/tmp/soms-browser-e2e/steps/scenario.mjs',
      ),
    ).toContain('paused');
    expect(localOperationBlockReason(state, 'read')).toBeUndefined();
    decideRun(state, 'continue');
    expect(state.phase).toBe('running');
    expect(
      localOperationBlockReason(state, 'edit', 'test/browser-e2e/driver.mjs'),
    ).toBeUndefined();
    expect(localOperationBlockReason(state, 'bash')).toBeUndefined();
    expect(() => assertBrowserAction(state, 'eval')).not.toThrow();
    pauseRun(state, {
      kind: 'DRIVER_MISMATCH',
      summary: 'Another stale selector',
      evidence: 'Changed UI again',
    });
    expect(localOperationBlockReason(state, 'bash')).toContain('paused');
    decideRun(state, 'continue');
    expect(
      localOperationBlockReason(state, 'edit', 'test/browser-e2e/driver.mjs'),
    ).toContain('Source changes');
  });
  it('registers batches atomically, preserves verdicts and persists through the run store', () => {
    const root = mkdtempSync(join(tmpdir(), 'soms-registration-'));
    try {
      const run = createRun(root, 'quick', nodes);
      recordCase(run.state, {
        id: 'Q0.pass',
        title: 'Passed',
        outcome: 'PASS',
        evidence: 'asserted',
      });
      recordCase(run.state, {
        id: 'Q1.bug',
        title: 'Bug',
        outcome: 'BUG',
        evidence: 'reproduced',
      });
      decideRun(run.state, 'continue');
      const before = structuredClone(run.state);
      expect(
        registerCases(run.state, [
          { id: 'Q0.pass', title: 'Passed' },
          { id: 'Q1.bug', title: 'Bug' },
          { id: 'Q4.text.send', title: 'Text exact-once receipt' },
        ]),
      ).toEqual({ requested: 3, added: 1, preserved: 2, round: 'Q0' });
      expect(run.state.cases.slice(0, -1)).toEqual(before.cases);
      expect(run.state.issues).toEqual(before.issues);
      expect(run.state.cases.at(-1)).toEqual({
        id: 'Q4.text.send',
        title: 'Text exact-once receipt',
        outcome: 'NOT RUN',
        evidence: '',
      });
      saveRun(run.directory, run.state);
      expect(loadRun(root, run.state.id).state.cases).toEqual(run.state.cases);
      expect(loadRun(root, run.state.id).state.roundCaseIds).toEqual([
        'Q0.pass',
        'Q1.bug',
        'Q4.text.send',
      ]);
      expect(
        readFileSync(join(run.directory, 'progress.md'), 'utf8'),
      ).toContain('Q4.text.send');
      expect(() => finishRun(run.state)).toThrow('Unfinished');
      const stable = structuredClone(run.state);
      const valid = { id: 'Q4.new', title: 'New assertion' };
      const invalidBatches = [
        [],
        Array.from({ length: 201 }, (_, i) => ({
          id: `Q4.${i}`,
          title: 'Assertion',
        })),
        [valid, valid],
        [valid, { id: '../invalid', title: 'Bad' }],
        [valid, { id: 'Q4.blank', title: ' ' }],
        [valid, { id: 'Q4.long', title: 'x'.repeat(501) }],
        [valid, { id: 'Q0.pass', title: 'Changed scope' }],
        [
          valid,
          { id: 'Q4.verdict', title: 'Not registration', outcome: 'PASS' },
        ],
      ];
      for (const batch of invalidBatches) {
        expect(() => registerCases(run.state, batch)).toThrow();
        expect(run.state).toEqual(stable);
      }
      for (const phase of ['paused', 'stopped', 'completed'] as const) {
        run.state.phase = phase;
        const snapshot = structuredClone(run.state);
        expect(() => registerCases(run.state, [valid])).toThrow('operator');
        expect(run.state).toEqual(snapshot);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('switches the active round from the registration batch prefix', () => {
    const root = mkdtempSync(join(tmpdir(), 'soms-round-'));
    try {
      const { state } = createRun(root, 'quick', nodes);
      // Leaf segments are never consumed; mixed batches fall back to chapter.
      expect(roundPrefixOf(['Q1.local-alpha.accept'])).toBe('Q1.local-alpha');
      expect(
        roundPrefixOf(['Q1.local-alpha.accept', 'Q1.local-alpha.cancel']),
      ).toBe('Q1.local-alpha');
      expect(
        roundPrefixOf([
          'Q4.dm-a.text.send',
          'Q4.dm-a.audio.send',
          'Q4.dm-b.text.send',
        ]),
      ).toBe('Q4');
      expect(
        registerCases(state, [
          { id: 'Q1.local-alpha.accept', title: 'Accept' },
          { id: 'Q1.local-alpha.cancel', title: 'Cancel' },
        ]),
      ).toMatchObject({ added: 2, round: 'Q1.local-alpha' });
      expect(state.round).toBe('Q1.local-alpha');
      // Re-registration preserves results but still switches the round.
      expect(
        registerCases(state, [
          { id: 'Q2.local-alpha.create', title: 'Create' },
          { id: 'Q2.local-alpha.invite', title: 'Invite' },
        ]),
      ).toMatchObject({ added: 2, round: 'Q2.local-alpha' });
      expect(state.round).toBe('Q2.local-alpha');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('keeps progress summaries bounded as case evidence and issue stacks grow', () => {
    const root = mkdtempSync(join(tmpdir(), 'soms-summary-'));
    try {
      const { state } = createRun(root, 'quick', nodes);
      for (let batch = 0; batch < 10; batch++)
        registerCases(
          state,
          Array.from({ length: 200 }, (_, i) => ({
            id: `Q4.b${batch}.${i}`,
            title: 'Assertion',
          })),
        );
      state.cases[0].evidence = 'private-evidence'.repeat(10000);
      pauseRun(state, {
        kind: 'DRIVER_MISMATCH',
        summary: 'Stack',
        evidence: 'private-stack'.repeat(10000),
      });
      const summary = progressSummary(state);
      expect(summary).toMatchObject({
        caseCount: 2007,
        phase: 'paused',
        issueCount: 1,
        outcomes: { 'NOT RUN': 2007 },
      });
      const text = JSON.stringify(summary);
      expect(text.length).toBeLessThan(500);
      expect(text).not.toContain('private-');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
