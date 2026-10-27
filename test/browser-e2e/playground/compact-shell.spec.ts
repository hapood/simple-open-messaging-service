import type { Locator } from '@playwright/test';
import { test, expect } from '../fixtures/playground';

async function expectShellBounds(panel: Locator) {
  await expect
    .poll(() =>
      panel.evaluate((element) => {
        const shell = element.closest('.shell')!.getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return Math.max(
          Math.abs(bounds.top - shell.top),
          Math.abs(bounds.bottom - shell.bottom),
          Math.abs(bounds.left - shell.left),
          Math.abs(bounds.right - shell.right),
        );
      }),
    )
    .toBeLessThan(1);
}

for (const fullWindow of [false, true]) {
  test(`compact overlays fill their shell with ${fullWindow ? 'full-window' : 'embedded'} bounds`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    if (fullWindow) {
      // Exercise the production geometry as well as the demo's offset shell.
      await page.locator('.project-bar').evaluate((bar) => {
        (bar as HTMLElement).style.display = 'none';
      });
      await page.locator('.playground-viewport').evaluate((root) => {
        (root as HTMLElement).style.height = '100dvh';
      });
    }
    const shell = page.locator('.shell.mode-compact');
    await expect(shell).toBeVisible();
    expect((await shell.boundingBox())!.y).toBe(fullWindow ? 0 : 56);
    await page.getByRole('button', { name: /^Playground Team, chat/ }).click();
    const chat = shell.locator('.chat-slot');
    await expectShellBounds(chat);
    const header = chat.locator('.pane-layer.pane-fg .msg-header');
    const more = header.getByRole('button', {
      name: 'More options',
      exact: true,
    });
    await expect(more).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('compact-chat.png') });
    const composer = chat.locator('.pane-layer.pane-fg app-chat-input');
    const composerBounds = (await composer.boundingBox())!;
    const shellBounds = (await shell.boundingBox())!;
    expect(composerBounds.y).toBeGreaterThanOrEqual(shellBounds.y);
    expect(composerBounds.y + composerBounds.height).toBeLessThanOrEqual(
      shellBounds.y + shellBounds.height,
    );
    await more.click();
    const aside = shell.locator('.aside-slot');
    await expect(aside.locator('app-group-info')).toBeVisible();
    await expectShellBounds(aside);
    await aside.locator('.member-overview-row').click();
    await expect(aside.locator('.member')).not.toHaveCount(0);
    await expectShellBounds(aside);
    await aside.locator('.member-manager .page-header__back').click();
    await expect(aside.locator('app-group-info:visible')).toHaveCount(0);
    await header.getByRole('button', { name: /^Back to chats/ }).click();
    await expect(
      page.getByRole('button', { name: /^Playground Team, chat/ }),
    ).toBeVisible();
  });
}
