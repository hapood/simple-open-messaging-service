import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Server version, read once at module load from the project-root package.json (the same
 * `process.cwd()` convention bootstrap.ts uses for uploadsDir / public). Cached at import time
 * because client compatibility and well-known discovery can be requested repeatedly. Falls back
 * to 'unknown' rather than crashing the process when the package metadata is unavailable.
 */
export const SERVER_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    );
    return typeof pkg.version === 'string' && pkg.version
      ? pkg.version
      : 'unknown';
  } catch {
    return 'unknown';
  }
})();
