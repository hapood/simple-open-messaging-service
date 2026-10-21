import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    // Every spec file runs in its own isolated environment (isolate is enabled
    // on the unit-test builder in angular.json), so parallel files cannot leak
    // state into each other. Parallelism only shortens wall-clock time on
    // multi-core machines; it does not affect test semantics.
    fileParallelism: true,
    restoreMocks: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
