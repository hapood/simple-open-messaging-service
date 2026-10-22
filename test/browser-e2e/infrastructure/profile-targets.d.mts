import type { BrowserTarget } from './targets.mjs';
export function profileTarget(
  root: string,
  name: string,
  requested?: BrowserTarget,
): BrowserTarget;
export function profileDirectory(
  root: string,
  name: string,
  target: BrowserTarget,
): string;
