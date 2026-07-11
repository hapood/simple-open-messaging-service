import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Server version, read once at module load from the project-root package.json (the same
 * `process.cwd()` convention bootstrap.ts uses for uploadsDir / public). Cached at import time —
 * health and well-known are hit on every probe/discovery, so re-reading the file per request would
 * be wasteful. Falls back to 'unknown' rather than throwing — version display must never crash the
 * process (a liveness probe must never 500 on a config quirk).
 *
 * Shared by HealthController (/api/v1/health) and WellKnownController (/.well-known/soms software).
 */
export const SERVER_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();
