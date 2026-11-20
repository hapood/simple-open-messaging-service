import { test, expect } from '../fixtures/playground';

test('header resumes task presentation when the tail cue leaves the viewport', async ({ page }) => {
  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  const pane = page.locator('.pane-layer.pane-fg');
  await expect(pane.locator('.msg-row').first()).toBeVisible();
  await page.evaluate(async () => {
    const component = (window as any).ng.getComponent(document.querySelector('.pane-fg app-message-thread'));
    await component.scroller.goToLatest();
    await component.sendOutbox.enqueue({
      clientMessageId: 'viewport-cue-test', threadId: component.threadId(),
      item: { type: 'PURE_TEXT', content: 'Viewport cue test' },
    });
  });
  const header = pane.locator('app-message-header .faces');
  await expect(pane.locator('app-tail-sending-cue .dots')).toBeVisible();
  await expect(header).not.toHaveClass(/tasks-visible/);
  await page.locator('.pane-fg .msg-viewport').evaluate(el => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 }));
    el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight);
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(header).toHaveClass(/tasks-visible/);
  await page.evaluate(async () => {
    const component = (window as any).ng.getComponent(document.querySelector('.pane-fg app-message-thread'));
    await component.scroller.goToLatest();
  });
  await expect(header).not.toHaveClass(/tasks-visible/);
  await page.evaluate(async () => {
    const component = (window as any).ng.getComponent(document.querySelector('.pane-fg app-message-thread'));
    await component.sendOutbox.remove('viewport-cue-test');
  });
  await expect(pane.locator('app-tail-sending-cue .msg-row')).toHaveCount(0);
});
