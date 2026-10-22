import { defineConfig } from '@playwright/test';

// Standalone mock UI: no federation lab, credentials, database, or HMR status files.
export default defineConfig({
  testDir: '.',
  testMatch: 'playground.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  outputDir: '/tmp/soms-playground/results',
  use: {
    baseURL: 'http://127.0.0.1:4301',
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
    launchOptions: {
      executablePath: process.env['CHROME_PATH'] || '/usr/bin/google-chrome',
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'npm --prefix web run start:playground -- --host 127.0.0.1 --port 4301',
    url: 'http://127.0.0.1:4301',
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
  },
});
