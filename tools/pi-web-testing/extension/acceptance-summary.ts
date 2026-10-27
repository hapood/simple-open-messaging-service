import { join } from 'node:path';
import {
  progressSummary,
  type DeploymentNode,
  type Issue,
  type RunState,
} from '../../../test/browser-e2e/infrastructure/acceptance-run.mjs';

/** Active acceptance run handle as owned by the extension. */
export type AcceptanceRunHandle = {
  directory: string;
  state: RunState;
};

/** Bounded metadata for the newest issue. Evidence and proposals stay only in the persisted document. */
export function issueDigest(issue: Issue | undefined) {
  if (!issue) return undefined;
  return {
    id: issue.id,
    kind: issue.kind,
    summary: issue.summary,
    ...(issue.caseId !== undefined ? { caseId: issue.caseId } : {}),
    ...(issue.decision !== undefined ? { decision: issue.decision } : {}),
  };
}

/**
 * Compact operational summary for mutating webtest_run actions. Emits progress
 * counts plus the latest issue digest and next step; the full cases/issues
 * history remains available only through the explicit status action and the
 * persisted run document.
 */
export function compactRunSummary(handle: AcceptanceRunHandle) {
  const { phase, caseCount, outcomes, issueCount } = progressSummary(
    handle.state,
  );
  return {
    directory: handle.directory,
    id: handle.state.id,
    phase,
    caseCount,
    outcomes,
    issueCount,
    issue: issueDigest(handle.state.issues.at(-1)),
    next: handle.state.next,
  };
}

/** Exact registered batch; older saved runs fall back to their dotted prefix. */
function roundCasesOf(state: RunState) {
  if (state.roundCaseIds) {
    const ids = new Set(state.roundCaseIds);
    return state.cases.filter((item) => ids.has(item.id));
  }
  const round = state.round;
  if (!round) return [];
  return state.cases.filter(
    (item) => item.id === round || item.id.startsWith(`${round}.`),
  );
}

/** Issues attached to the active round's cases; unattached issues stay out. */
function roundIssuesOf(state: RunState) {
  const ids = new Set(roundCasesOf(state).map((item) => item.id));
  return state.issues.filter(
    (issue) => issue.caseId !== undefined && ids.has(issue.caseId),
  );
}

/**
 * Round-scoped view for the status action. Combines the compact run summary
 * with the active round's complete case list (outcome plus evidence) and the
 * issue digests attached to those cases. Cases and issues outside the round
 * stay out of context; use caseDetail for one case's full bug records and
 * bounded reads of run.json for older rounds.
 */
export function roundView(handle: AcceptanceRunHandle) {
  const cases = roundCasesOf(handle.state);
  const outcomes: Record<string, number> = {};
  for (const item of cases)
    outcomes[item.outcome] = (outcomes[item.outcome] ?? 0) + 1;
  const roundIssues = roundIssuesOf(handle.state);
  return {
    ...compactRunSummary(handle),
    ...(handle.state.round
      ? { round: { id: handle.state.round, caseCount: cases.length, outcomes } }
      : { round: null }),
    cases: cases.map((item) => ({
      id: item.id,
      title: item.title,
      outcome: item.outcome,
      evidence: item.evidence,
    })),
    roundIssues: roundIssues.map((issue) => issueDigest(issue)),
    otherIssueCount: handle.state.issues.length - roundIssues.length,
    fullDocument: join(handle.directory, 'run.json'),
  };
}

/**
 * Full detail for one case: its record plus every issue attached to it with
 * complete evidence and proposals. Bounded by a single case's own history.
 */
export function caseDetail(handle: AcceptanceRunHandle, id: string) {
  const record = handle.state.cases.find((item) => item.id === id);
  if (!record) throw new Error(`Unknown case: ${id}`);
  return {
    ...compactRunSummary(handle),
    case: record,
    issues: handle.state.issues.filter((issue) => issue.caseId === id),
  };
}

/** Deployment identity kept in resume prompts: reachable edge, home domain and login account only. */
function nodeIdentity(node: DeploymentNode) {
  return {
    edge: node.edge,
    domain: node.domain,
    ...(node.account !== undefined ? { account: node.account } : {}),
  };
}

/**
 * Compact context embedded into generated resume prompts. Contains run
 * identity, deployment pointers, progress counts, the latest issue digest and
 * the persisted evidence directory — never the historical cases/issues arrays.
 */
export function compactRunContext(handle: AcceptanceRunHandle) {
  const { phase, caseCount, outcomes, issueCount } = progressSummary(
    handle.state,
  );
  const nodes = Object.fromEntries(
    Object.entries(handle.state.nodes).map(([name, node]) => [
      name,
      nodeIdentity(node),
    ]),
  );
  return {
    id: handle.state.id,
    mode: handle.state.mode,
    phase,
    caseCount,
    outcomes,
    issueCount,
    ...(handle.state.round ? { round: handle.state.round } : {}),
    nodes,
    issue: issueDigest(handle.state.issues.at(-1)),
    next: handle.state.next,
    evidenceDirectory: handle.directory,
  };
}
