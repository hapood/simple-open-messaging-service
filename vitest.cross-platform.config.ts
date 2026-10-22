import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/cross-platform/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/.git/**'],
  },
});
