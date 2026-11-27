import { test, expect } from '../fixtures/playground';

test('failed POST counts coexist with dots until the current gap is covered', async ({
  page,
}) => {
  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  const pane = page.locator('.pane-layer.pane-fg');
  await expect(pane.locator('.msg-viewport')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(pane.locator('.msg-row').first()).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const state = window as any;
      const component = state.ng.getComponent(
        document.querySelector('.pane-fg app-message-thread'),
      );
      const jumped = await component.scroller.goToLatest();
      component.threadAdapter.confirmDelay.set(0);
      component.threadAdapter.sendError.set(true);
      const sendIntent = component.threadAdapter.sendIntent.bind(
        component.threadAdapter,
      );
      state.releaseFailedPosts = [];
      component.threadAdapter.sendIntent = (request: unknown) =>
        new Promise<void>((resolve) => {
          state.releaseFailedPosts.push(resolve);
        }).then(() => sendIntent(request));
      state.failureScans = [];
      const initialHead = component.latestTailEnd();
      component.source.beforeHistoryScan = (range: { right: number }) =>
        range.right <= initialHead
          ? Promise.resolve()
          : new Promise<void>((resolve) =>
              state.failureScans.push({ range, release: resolve }),
            );
      state.pendingTailSends = Promise.all([
        component.messageSender.text('First simulated failure'),
        component.messageSender.text('Second simulated failure'),
      ]);
      return jumped;
    }),
  ).toBe(true);
  const tail = pane
    .locator('app-tail-activity-row')
    .filter({ has: page.locator('.tail-activity-row') });
  const dots = tail.locator('.tail-self .dots');
  const messages = tail.locator('app-task-count-group').first();
  await expect(tail).toHaveCount(1);
  await expect(dots).toBeVisible();
  await expect(messages.locator('.current')).toHaveText('2');
  await expect(tail.locator('.failures .current')).toHaveCount(0);
  expect(await tail.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(
    40,
  );
  await page.evaluate(() => {
    const state = window as any;
    state.releaseFailedPosts.forEach((release: () => void) => release());
    return state.pendingTailSends;
  });
  await expect(messages.locator('.current')).toHaveCount(0);
  await expect(tail.locator('.failures .current')).toHaveText('2');
  await expect(dots).toBeVisible();
  await expect(
    pane.locator('.msg-bubble-text').filter({ hasText: 'simulated failure' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const component = (window as any).ng.getComponent(
        document.querySelector('.pane-fg app-message-thread'),
      );
      return component.sendOutbox
        .forThread(component.threadId())
        .map((row: any) => row.execution.phase);
    }),
  ).toEqual(['failed', 'failed']);

  // Failure is POST state, not proof that a history interval was fetched. A
  // successful deleted-only scan can finish the dots without erasing failures.
  await page.evaluate(() => {
    const state = window as any;
    const component = state.ng.getComponent(
      document.querySelector('.pane-fg app-message-thread'),
    );
    component.source.advanceDeletedHead(component.source.allocateMsgId() + 1);
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).failureScans.length))
    .toBe(1);
  await expect(dots).toBeVisible();
  await page.evaluate(() => (window as any).failureScans[0].release());
  await expect(dots).toHaveCount(0);
  await expect(tail.locator('.failures .current')).toHaveText('2');
  expect(await tail.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(
    40,
  );
  await page.evaluate(async () => {
    const component = (window as any).ng.getComponent(
      document.querySelector('.pane-fg app-message-thread'),
    );
    for (const row of component.sendOutbox.forThread(component.threadId()))
      await component.sendOutbox.remove(row.task.clientMessageId);
  });
  await expect(
    pane.locator('app-tail-activity-row .tail-activity-row'),
  ).toHaveCount(0);
});
