export type FrontendStatus = {
  service: 'web' | 'admin';
  state: 'building' | 'success' | 'failure';
  sessionId: string;
  buildId: number;
  observerPid?: number;
  childPid?: number;
  pid: number | null;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  diagnostics: string[];
  processRunning: boolean;
};
export function artifactDirectory(): string;
export function readFrontendStatus(
  service: 'web' | 'admin',
): Promise<FrontendStatus>;
