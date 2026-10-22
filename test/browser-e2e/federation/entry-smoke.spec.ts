import { test, expect } from '../fixtures/federation';

const edges = [
  ['alpha', 'http://localhost:3101/'],
  ['bravo', 'http://localhost:3102/'],
  ['charlie', 'http://localhost:3103/'],
] as const;

test.describe('federation lab browser entry points', () => {
  for (const [node, url] of edges) {
    test(`${node} web edge renders in a real browser`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveTitle(/^SOMS(?: — .+)?$/);
      await expect(page).toHaveURL(/\/auth\/qr/);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('app-qr-code')).toBeVisible();
      expect(consoleErrors).toEqual([]);
    });
  }
});
