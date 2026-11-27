import { test, expect } from '../fixtures/playground';

test('header resumes task presentation when the tail row leaves the viewport', async ({
  page,
}) => {
  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  const pane = page.locator('.pane-layer.pane-fg');
  const viewport = pane.locator('.msg-viewport');
  await expect(viewport).toHaveAttribute('aria-busy', 'false');
  await expect(pane.locator('.msg-row').first()).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const component = (window as any).ng.getComponent(
        document.querySelector('.pane-fg app-message-thread'),
      );
      const jumped = await component.scroller.goToLatest();
      for (const n of [1, 2]) {
        await component.sendOutbox.enqueue({
          clientMessageId: `viewport-cue-test-${n}`,
          threadId: component.threadId(),
          item: { type: 'PURE_TEXT', content: `Viewport cue test ${n}` },
        });
      }
      return jumped;
    }),
  ).toBe(true);
  const header = pane.locator('app-message-header .faces');
  const tail = pane.locator('app-tail-activity-row .tail-activity-row');
  await expect(tail).toHaveCount(1);
  await expect(tail.locator('.tail-self .dots')).toBeVisible();
  await expect(
    tail.locator('app-task-count-group').first().locator('.current'),
  ).toHaveText('2');
  await expect(tail).toBeInViewport();
  await expect(header).not.toHaveClass(/tasks-visible/);
  await viewport.evaluate((el) => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 }));
    el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight);
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(tail).not.toBeInViewport();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const component = (window as any).ng.getComponent(
          document.querySelector('.pane-fg app-message-thread'),
        );
        return component.scroller.isPinnedToBottom();
      }),
    )
    .toBe(false);
  await expect(header).toHaveClass(/tasks-visible/);
  await expect(
    header.locator('app-task-count-group').first().locator('.current'),
  ).toHaveText('2');
  expect(
    await page.evaluate(async () => {
      const component = (window as any).ng.getComponent(
        document.querySelector('.pane-fg app-message-thread'),
      );
      return component.scroller.goToLatest();
    }),
  ).toBe(true);
  await expect(tail).toBeInViewport();
  await expect(header).not.toHaveClass(/tasks-visible/);
  await page.evaluate(async () => {
    const component = (window as any).ng.getComponent(
      document.querySelector('.pane-fg app-message-thread'),
    );
    for (const n of [1, 2])
      await component.sendOutbox.remove(`viewport-cue-test-${n}`);
  });
  await expect(tail.locator('app-task-count-group .current')).toHaveCount(0);
  // Removing POST tasks is not interval coverage and must not complete the dots.
  await expect(tail.locator('.tail-self .dots')).toBeVisible();
  await expect(header).not.toHaveClass(/tasks-visible/);
  await page.getByRole('button', { name: /^Liam, chat/ }).click();
  await expect(
    page.locator('app-tail-activity-row .tail-activity-row'),
  ).toHaveCount(0);
});
