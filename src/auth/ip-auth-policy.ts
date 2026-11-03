import type { BanStep } from './brute-force.service.js';

/** Shared password-login and session-credential IP failure policy. Keep thresholds
 * lenient because several legitimate clients may share one public address. */
export const IP_AUTH_FAILURE_STEPS: readonly BanStep[] = [
  { count: 10, banMs: 30 * 60 * 1000 },
  { count: 20, banMs: 3 * 60 * 60 * 1000 },
  { count: 40, banMs: 24 * 60 * 60 * 1000 },
];
