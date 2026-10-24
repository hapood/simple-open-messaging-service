export type AcceptanceMode = 'quick' | 'full';
export type DeploymentNode = {
  edge: string;
  admin: string;
  service: string;
  domain: string;
  account?: string;
};
export type Outcome =
  | 'NOT RUN'
  | 'PASS'
  | 'BUG'
  | 'BLOCKED'
  | 'SKIPPED'
  | 'NOT VERIFIED';
export type IssueKind =
  | 'PRODUCT_BUG'
  | 'DRIVER_MISMATCH'
  | 'ENVIRONMENT'
  | 'UNCLASSIFIED';
export type CaseRecord = {
  id: string;
  title: string;
  outcome: Outcome;
  evidence: string;
};
export type Issue = {
  id: string;
  kind: IssueKind;
  summary: string;
  evidence: string;
  proposal?: string;
  caseId?: string;
  decision?: string;
  failureSource?: 'browser-command';
  recovery?: {
    scope: 'arguments' | 'temporary-step';
    path?: string;
  };
};
export type RunState = {
  version: number;
  id: string;
  mode: AcceptanceMode;
  nodes: Record<string, DeploymentNode>;
  phase: 'running' | 'paused' | 'stopped' | 'completed';
  createdAt: string;
  updatedAt?: string;
  cases: CaseRecord[];
  issues: Issue[];
  next: string;
  checkpoint?: string;
};
export function endpoint(value: string): string;
export function deploymentNode(
  externalUrl: string,
  internalAdminUrl?: string,
  account?: string,
): DeploymentNode & { account: string };
export function resolveDeploymentIdentity(
  nodes: Record<string, DeploymentNode>,
  key: string,
  rawDomain: unknown,
): string;
export function validateDeployment(
  mode: string,
  input: Record<string, DeploymentNode>,
): Record<string, DeploymentNode & { account: string }>;
export const quickCases: string[][];
export function initialCases(mode: AcceptanceMode): CaseRecord[];
export function createRun(
  root: string,
  mode: AcceptanceMode,
  input: Record<string, DeploymentNode>,
): { directory: string; state: RunState };
export function saveRun(directory: string, state: RunState): void;
export function loadRun(
  root: string,
  id: string,
): { directory: string; state: RunState };
export function registerCases(
  state: RunState,
  items: Pick<CaseRecord, 'id' | 'title'>[],
): { requested: number; added: number; preserved: number };
export function progressSummary(state: RunState): {
  id: string;
  phase: RunState['phase'];
  caseCount: number;
  outcomes: Partial<Record<Outcome, number>>;
  issueCount: number;
};
export function recordCase(state: RunState, item: CaseRecord): void;
export function pauseRun(state: RunState, issue: Omit<Issue, 'id'>): Issue;
export function decideRun(state: RunState, decision: string): void;
export function assertBrowserAction(
  state: RunState | undefined,
  action: string,
): void;
export function finishRun(state: RunState): void;
