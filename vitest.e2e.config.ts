import { defineConfig } from 'vitest/config';

// E2E tests. globalSetup applies the SQL baseline once; setupFiles (per
// worker) forces DATABASE_URL to the isolated soms_test DB before AppModule
// boots. Generous timeouts for argon2 + a real Postgres round-trip.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts'],
    // Each worker resets/migrates its own PostgreSQL database. Bounding the
    // pool keeps full-suite runs from starving double-node process bootstraps.
    maxWorkers: 2,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
