import { defineConfig } from 'vitest/config';

// Unit tests. Vitest is native ESM and resolves the `.js`-suffixed relative
// imports (emitted by the ESM codemod) back to their `.ts` source via vite.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
