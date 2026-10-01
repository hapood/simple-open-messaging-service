import { randomBytes } from 'node:crypto';
import { defineConfig } from 'vitest/config';
process.env.SOMS_E2E_RUN_ID ??= randomBytes(6).toString('hex');
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/federation-message-roundtrip.e2e-spec.ts'],
    setupFiles: ['./test/roundtrip-setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
