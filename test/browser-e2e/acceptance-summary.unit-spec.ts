import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  registerCases,
  type RunState,
} from './infrastructure/acceptance-run.mjs';
import {
  caseDetail,
  compactRunContext,
  compactRunSummary,
  issueDigest,
  roundView,
} from '../../tools/pi-web-testing/extension/acceptance-summary';

const directory = '/tmp/acceptance/runs/run-under-test';

function state(): RunState {
  return {
    version: 1,
    id: 'run-1',
    mode: 'quick',
    nodes: {
      alpha: {
        edge: 'https://alpha.test/',
        admin: 'https://alpha.test/admin/',
        service: 'https://alpha.test/',
        domain: 'alpha.test',
        account: 'admin',
      },
      bravo: {
        edge: 'https://bravo.test/',
        admin: 'https://bravo.test/admin/',
        service: 'https://bravo.test/',
        domain: 'bravo.test',
      },
    },
    phase: 'paused',
    createdAt: '2026-10-24T13:03:18.551Z',
    updatedAt: '2026-10-25T09:31:26.516Z',
    cases: [
      {
        id: 'Q0',
        title: 'Environment',
        outcome: 'PASS',
        evidence: 'x'.repeat(2000),
      },
      {
        id: 'Q1',
        title: 'Friendship',
        outcome: 'PASS',
        evidence: 'y'.repeat(2000),
      },
      {
        id: 'Q5',
        title: 'Avatars',
        outcome: 'BLOCKED',
        evidence: 'z'.repeat(2000),
      },
    ],
    issues: [
      {
        id: 'issue-1',
        kind: 'DRIVER_MISMATCH',
        summary: 'Old issue',
        evidence: 'old evidence',
        decision: 'continue',
      },
      {
        id: 'issue-2',
        kind: 'PRODUCT_BUG',
        summary: 'Editor avatar missing',
        evidence: 'very long evidence '.repeat(500),
        proposal: 'very long proposal '.repeat(500),
        decision: 'continue',
      },
    ],
    next: 'Paused at issue-2: Editor avatar missing.',
    checkpoint: 'resume: continue Q5',
  };
}

const handle = () => ({ directory, state: state() });

describe('issueDigest', () => {
  it('keeps only bounded metadata and never evidence or proposals', () => {
    const digest = issueDigest(state().issues.at(-1));
    expect(digest).toEqual({
      id: 'issue-2',
      kind: 'PRODUCT_BUG',
      summary: 'Editor avatar missing',
      decision: 'continue',
    });
    const text = JSON.stringify(digest ?? {});
    expect(text).not.toContain('evidence');
    expect(text).not.toContain('proposal');
  });

  it('returns undefined without an issue and keeps optional fields when present', () => {
    expect(issueDigest(undefined)).toBeUndefined();
    expect(issueDigest({ ...state().issues[0], caseId: 'Q1' })).toMatchObject({
      id: 'issue-1',
      caseId: 'Q1',
      decision: 'continue',
    });
  });
});

describe('compactRunSummary', () => {
  it('reports counts, latest issue digest and next step without history arrays', () => {
    const summary = compactRunSummary(handle());
    expect(summary).toMatchObject({
      directory,
      id: 'run-1',
      phase: 'paused',
      caseCount: 3,
      outcomes: { PASS: 2, BLOCKED: 1 },
      issueCount: 2,
      issue: { id: 'issue-2', decision: 'continue' },
      next: 'Paused at issue-2: Editor avatar missing.',
    });
    expect(summary).not.toHaveProperty('cases');
    expect(summary).not.toHaveProperty('issues');
    expect(summary).not.toHaveProperty('nodes');
    expect(JSON.stringify(summary)).not.toContain('very long');
  });
});

describe('roundView', () => {
  it('keeps each quick manifest isolated after previous rounds, including shared Q4 prefixes', () => {
    const active = handle();
    active.state.phase = 'running';
    const manifests = new URL(
      '../../docs/development/browser-e2e-quick-rounds/',
      import.meta.url,
    );
    const seen = new Set<string>();
    for (const file of readdirSync(manifests)
      .filter((name) => name.endsWith('.md'))
      .sort()) {
      const cases = readFileSync(new URL(file, manifests), 'utf8')
        .split('\n')
        .filter((line) => /^\| Q\d/.test(line))
        .map((line) => {
          const [, id, title] = line.split('|');
          return { id: id.trim(), title: title.trim() };
        });
      expect(cases.length).toBeGreaterThan(0);
      expect(cases.length).toBeLessThanOrEqual(32);
      for (const item of cases) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      registerCases(active.state, cases);
      active.state.issues.push({
        id: `issue-${file}`,
        kind: 'PRODUCT_BUG',
        caseId: cases[0].id,
        summary: 'Round issue',
        evidence: 'Observed mismatch',
      });
      const view = roundView(active);
      expect(view.cases.map((item) => item.id)).toEqual(
        cases.map((item) => item.id),
      );
      expect(view.round?.caseCount).toBe(cases.length);
      expect(view.roundIssues.map((issue) => issue?.id)).toEqual([
        `issue-${file}`,
      ]);
    }
  });

  it('shows every member of a mixed-prefix batch and switches back without losing results', () => {
    const active = handle();
    active.state.phase = 'running';
    const cases = [
      { id: 'Q1.a', title: 'First' },
      { id: 'Q2.b', title: 'Second' },
    ];
    registerCases(active.state, cases);
    active.state.cases.find((item) => item.id === 'Q1.a')!.outcome = 'PASS';
    registerCases(active.state, [{ id: 'Q3.c', title: 'Other round' }]);
    expect(roundView(active).cases.map((item) => item.id)).toEqual(['Q3.c']);
    registerCases(active.state, cases);
    expect(
      roundView(active).cases.map((item) => [item.id, item.outcome]),
    ).toEqual([
      ['Q1.a', 'PASS'],
      ['Q2.b', 'NOT RUN'],
    ]);
  });

  it('scopes cases and issue digests to the active round', () => {
    const active = handle();
    active.state.round = 'Q1';
    active.state.issues.push({
      id: 'issue-3',
      kind: 'DRIVER_MISMATCH',
      summary: 'Q1 step miss',
      evidence: 'secret stack',
      caseId: 'Q1',
    });
    const view = roundView(active);
    expect(view.round).toEqual({
      id: 'Q1',
      caseCount: 1,
      outcomes: { PASS: 1 },
    });
    expect(view.cases).toEqual([
      {
        id: 'Q1',
        title: 'Friendship',
        outcome: 'PASS',
        evidence: 'y'.repeat(2000),
      },
    ]);
    expect(view.roundIssues).toEqual([
      {
        id: 'issue-3',
        kind: 'DRIVER_MISMATCH',
        summary: 'Q1 step miss',
        caseId: 'Q1',
      },
    ]);
    expect(view.otherIssueCount).toBe(2);
    expect(view.fullDocument).toBe(join(directory, 'run.json'));
  });

  it('degrades to a round-less compact view for legacy runs', () => {
    const view = roundView(handle());
    expect(view.round).toBeNull();
    expect(view.cases).toEqual([]);
    expect(view.roundIssues).toEqual([]);
    expect(view.otherIssueCount).toBe(2);
    expect(view.fullDocument).toBe(join(directory, 'run.json'));
  });
});

describe('caseDetail', () => {
  it('returns one case with its full issues and rejects unknown ids', () => {
    const active = handle();
    active.state.issues.push({
      id: 'issue-3',
      kind: 'PRODUCT_BUG',
      summary: 'Q5 blocker',
      evidence: 'full case evidence',
      caseId: 'Q5',
    });
    const detail = caseDetail(active, 'Q5');
    expect(detail.case).toMatchObject({ id: 'Q5', outcome: 'BLOCKED' });
    expect(detail.issues).toEqual([
      expect.objectContaining({
        id: 'issue-3',
        evidence: 'full case evidence',
      }),
    ]);
    expect(() => caseDetail(active, 'Q9')).toThrow('Unknown case');
  });
});

describe('compactRunContext', () => {
  it('embeds deployment identity and the evidence directory, not full node or case data', () => {
    const context = compactRunContext(handle());
    expect(context).toMatchObject({
      id: 'run-1',
      mode: 'quick',
      phase: 'paused',
      caseCount: 3,
      outcomes: { PASS: 2, BLOCKED: 1 },
      issueCount: 2,
      evidenceDirectory: directory,
    });
    expect(context.nodes).toEqual({
      alpha: {
        edge: 'https://alpha.test/',
        domain: 'alpha.test',
        account: 'admin',
      },
      bravo: { edge: 'https://bravo.test/', domain: 'bravo.test' },
    });
    expect(context).not.toHaveProperty('cases');
    expect(context).not.toHaveProperty('issues');
    expect(JSON.stringify(context)).not.toContain('admin/');
    expect(JSON.stringify(context)).not.toContain('checkpoint');
  });
});
