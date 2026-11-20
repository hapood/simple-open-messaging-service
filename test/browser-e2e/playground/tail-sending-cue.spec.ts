import { test, expect } from '../fixtures/playground';

test('self sending cue is measured with history and disappears after confirmation', async ({ page }) => {
  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  const pane = page.locator('.pane-layer.pane-fg');
  await expect(pane.locator('.msg-row').first()).toBeVisible();
  await page.evaluate(async () => {
    const ng = (window as any).ng;
    const component = ng.getComponent(document.querySelector('.pane-fg app-message-thread'));
    component.threadAdapter.confirmDelay.set(1800);
    component.threadAdapter.opponentPushCount.set(0);
    await component.scroller.goToLatest();
    (window as any).tailSend = component.messageSender.text('Tail sending browser verification');
  });
  const cue = pane.locator('app-tail-sending-cue .dots');
  await expect(cue).toBeVisible();
  await expect(pane.locator('app-tail-sending-cue .msg-row')).toHaveCount(1);
  await expect(pane.locator('app-message-header .faces')).not.toHaveClass(/tasks-visible/);
  await page.evaluate(() => (window as any).tailSend);
  await expect(cue).toHaveCount(0);
  await expect(pane.locator('.msg-bubble-text').filter({ hasText: 'Tail sending browser verification' })).toBeVisible();
});
