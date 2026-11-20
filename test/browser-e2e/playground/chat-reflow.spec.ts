import { test, expect } from '../fixtures/playground';

test('self-avatar setting updates the open chat height model', async ({ page }) => {
  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  await expect(page.locator('.pane-fg .msg-row').first()).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByText('Appearance', { exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Show my avatar' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-show-self-avatar', 'false');
  await expect.poll(() => page.evaluate(() => {
    const host = document.querySelector('.pane-fg app-message-thread');
    if (!host) return -2;
    const component = (window as any).ng.getComponent(host);
    if (component.scroller.layoutSettleTimer !== undefined) return -1;
    let mismatches = 0;
    component.scroller.visitMountedGeometry((row: any) => {
      if (row.height !== row.el.offsetHeight) mismatches++;
    });
    return mismatches;
  })).toBe(0);
});

// Inspect production geometry rather than inferring correctness from screenshots.
test('chat width changes settle row heights without moving the reading scroll offset', async ({ page }) => {
  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  await expect(page.locator('.pane-fg .msg-row').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const component = (window as any).ng.getComponent(document.querySelector('.pane-fg app-message-thread'));
    return component.scroller.getInfo().mounted;
  })).toBeGreaterThan(10);
  const before = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.pane-fg .msg-viewport')!;
    viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
    return viewport.scrollTop;
  });
  await page.setViewportSize({ width: 1120, height: 1000 });
  await expect.poll(() => page.evaluate(() => {
    const component = (window as any).ng.getComponent(document.querySelector('.pane-fg app-message-thread'));
    if (component.scroller.layoutSettleTimer !== undefined) return -1;
    let mismatches = 0;
    component.scroller.visitMountedGeometry((row: any) => {
      if (row.height !== row.el.offsetHeight) mismatches++;
    });
    return mismatches;
  })).toBe(0);
  expect(await page.locator('.pane-fg .msg-viewport').evaluate(el => el.scrollTop)).toBeCloseTo(before, 0);
});
