export type BrowserTarget = 'playground' | 'federation';
export const federationNodes: Record<
  'alpha' | 'bravo' | 'charlie',
  { edge: string; admin: string; domain: string }
>;
export const playgroundOrigin: string;
export function assertTarget(target: unknown): BrowserTarget;
export function navigationUrl(
  target: BrowserTarget,
  node?: string,
  rawUrl?: string,
): string;
export function assertProfileTarget(
  existing: BrowserTarget | undefined,
  requested: unknown,
): BrowserTarget;
