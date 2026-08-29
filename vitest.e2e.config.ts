import { randomBytes } from 'node:crypto';
import { defineConfig } from 'vitest/config';
import { E2E_MAX_WORKERS } from './test/e2e-config.js';

// Separate Vitest invocations may run concurrently (for example, a developer
// running one spec while CI runs the suite). A per-run namespace prevents one
// global setup from recreating databases that are still in use by another.
process.env.SOMS_E2E_RUN_ID ??= randomBytes(6).toString('hex');

// E2E tests. globalSetup applies the SQL baseline once; setupFiles (per worker)
// selects this run's isolated database before AppModule boots. Generous
// timeouts cover argon2 and real PostgreSQL round-trips.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts'],
    // Each worker resets/migrates its own PostgreSQL database. Bounding the
    // pool keeps full-suite runs from starving double-node process bootstraps.
    maxWorkers: E2E_MAX_WORKERS,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
