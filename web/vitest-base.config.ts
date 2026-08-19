import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    fileParallelism: false,
    restoreMocks: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
