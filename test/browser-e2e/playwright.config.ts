import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import {
  browserLaunchOptions,
  repositoryRoot,
} from './infrastructure/browser-runtime.mjs';
import { playgroundOrigin } from './infrastructure/targets.mjs';

// Every invocation owns its artifacts; simultaneous target runs never clean each other's evidence.
const runId =
  process.env['SOMS_BROWSER_RUN_ID'] ?? `${Date.now()}-${randomUUID()}`;
if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid browser run ID.');
// Config is also loaded in workers: inherit the invocation identity instead of minting another directory.
process.env['SOMS_BROWSER_RUN_ID'] = runId;
const runDirectory = join(repositoryRoot, 'test-results/browser-e2e', runId);
export default defineConfig({
  testDir: '.',
  forbidOnly: !!process.env['CI'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: join(runDirectory, 'artifacts'),
  reporter: [
    ['list'],
    ['html', { outputFolder: join(runDirectory, 'report'), open: 'never' }],
  ],
  use: {
    browserName: 'chromium',
    launchOptions: browserLaunchOptions(),
    headless: process.env['BROWSER_HEADFUL'] !== '1',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Target-owned worker fixtures start/check only the selected environment, not a global webServer.
  projects: [
    {
      name: 'playground',
      testMatch: '**/playground/**/*.spec.ts',
      use: {
        baseURL: playgroundOrigin,
        viewport: { width: 1440, height: 1000 },
        locale: 'en-US',
      },
    },
    ...[
      ['desktop', 1440, 1000],
      ['tablet-web', 900, 1100],
      ['mobile-web', 390, 844],
    ].map(([name, width, height]) => ({
      name: `federation-${name}`,
      testMatch: '**/federation/**/*.spec.ts',
      use: {
        viewport: { width: Number(width), height: Number(height) },
        isMobile: name === 'mobile-web',
        hasTouch: name === 'mobile-web',
      },
    })),
  ],
});
