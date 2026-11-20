import { test, expect } from '../fixtures/playground';

test('multiple pending sends share a cue and failure-only state replaces the dots', async ({ page }) => {
  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  const pane = page.locator('.pane-layer.pane-fg');
  await expect(pane.locator('.msg-row').first()).toBeVisible();
  await page.evaluate(async () => {
    const component = (window as any).ng.getComponent(document.querySelector('.pane-fg app-message-thread'));
    component.threadAdapter.confirmDelay.set(1800);
    component.threadAdapter.sendError.set(true);
    await component.scroller.goToLatest();
    (window as any).pendingTailSends = Promise.all([
      component.messageSender.text('First simulated failure'),
      component.messageSender.text('Second simulated failure'),
    ]);
  });
  const tail = pane.locator('app-tail-sending-cue').filter({ has: page.locator('.msg-row') });
  await expect(tail).toHaveCount(1);
  await expect(tail.locator('.dots')).toBeVisible();
  await expect(tail.locator('app-outbox-indicator')).toBeVisible();
  await expect(tail.locator('app-task-count-group').first().locator('.current')).toHaveText('2');
  await page.evaluate(() => (window as any).pendingTailSends);
  await expect(tail.locator('.dots')).toHaveCount(0);
  await expect(tail.locator('.failures .current')).toHaveText('2');
  await page.evaluate(async () => {
    const component = (window as any).ng.getComponent(document.querySelector('.pane-fg app-message-thread'));
    for (const row of component.sendOutbox.forThread(component.threadId()))
      await component.sendOutbox.remove(row.task.clientMessageId);
  });
  await expect(pane.locator('app-tail-sending-cue .msg-row')).toHaveCount(0);
});
