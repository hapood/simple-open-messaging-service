import { defineConfig } from 'vitest/config';

// E2E tests. globalSetup runs `prisma migrate deploy` once; setupFiles (per
// worker) forces DATABASE_URL to the isolated soms_test DB before AppModule
// boots. Generous timeouts for argon2 + a real Postgres round-trip.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
