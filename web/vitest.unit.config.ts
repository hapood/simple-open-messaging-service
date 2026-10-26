import { defineConfig } from 'vitest/config';

// Pure-TS unit tests that do not need the Angular builder (components with
// templates/scss stay under `ng test`, which owns the application build).
// Runs directly with Vitest from web/ via `npm run test:unit`.
export default defineConfig({
  test: {
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    include: [
      'src/playground/deployment/compose-generator.spec.ts',
      'src/app/services/thread-list-order.spec.ts',
    ],
  },
});
