import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/browser-e2e/**/*.unit-spec.ts'],
    exclude: ['**/node_modules/**', '**/.git/**'],
  },
});
