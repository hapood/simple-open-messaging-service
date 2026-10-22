import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import { startPlaygroundServer } from '../infrastructure/playground-server.mjs';

export const test = base.extend<
  { mockEvidence: void },
  { playgroundServer: void }
>({
  mockEvidence: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = [];
      const apiRequests: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      page.on('request', (request) => {
        if (request.url().includes('/api/v1/')) apiRequests.push(request.url());
      });
      testInfo.annotations.push({
        type: 'mock-only',
        description: 'No live API or database',
      });
      await page.goto('/');
      await expect(page.locator('app-home-shell')).toBeVisible();
      await use();
      expect(errors).toEqual([]);
      expect(apiRequests).toEqual([]);
    },
    { auto: true },
  ],
  playgroundServer: [
    async ({}, use, workerInfo) => {
      await mkdir(workerInfo.project.outputDir, { recursive: true });
      const stop = await startPlaygroundServer(
        join(
          workerInfo.project.outputDir,
          `server-${workerInfo.workerIndex}.log`,
        ),
      );
      try {
        await use();
      } finally {
        await stop();
      }
    },
    { scope: 'worker', auto: true, timeout: 200_000 },
  ],
});
export { expect };
