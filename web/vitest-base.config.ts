import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    attachmentsDir: fileURLToPath(
      new URL('../test-results/web-unit/attachments/', import.meta.url),
    ),
    browser: {
      screenshotDirectory: fileURLToPath(
        new URL('../test-results/web-unit/', import.meta.url),
      ),
    },
    // Angular's browser runner owns TestBed and file isolation. Use real browser APIs by default;
    // specs must mock only the boundaries relevant to their scenario, not replace the entire DOM.
    fileParallelism: true,
    restoreMocks: true,
  },
});
