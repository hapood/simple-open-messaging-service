import { test, expect } from '../fixtures/playground';

test('POST counts finish independently while tail dots await current interval coverage', async ({
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
      const adapter = component.threadAdapter;
      adapter.confirmDelay.set(0);
      adapter.opponentPushCount.set(0);
      const sendIntent = adapter.sendIntent.bind(adapter);
      state.releaseTailPosts = [];
      adapter.sendIntent = (request: unknown) =>
        new Promise<void>((resolve) => {
          state.releaseTailPosts.push(resolve);
        }).then(() => sendIntent(request));
      state.tailScans = [];
      const initialHead = component.latestTailEnd();
      component.source.beforeHistoryScan = (range: { right: number }) =>
        range.right <= initialHead
          ? Promise.resolve()
          : new Promise<void>((resolve) =>
              state.tailScans.push({ range, release: resolve }),
            );
      state.tailSends = [1, 2, 3].map((n) =>
        component.messageSender.text(`Tail interval verification ${n}`),
      );
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
  await expect(messages.locator('.current')).toHaveText('3');
  await expect(pane.locator('app-message-header .faces')).not.toHaveClass(
    /tasks-visible/,
  );
  await expect(
    pane
      .locator('.msg-bubble-text')
      .filter({ hasText: 'Tail interval verification' }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      tail.evaluate((el) => {
        const component = (window as any).ng.getComponent(
          document.querySelector('.pane-fg app-message-thread'),
        );
        const host = el.parentElement as HTMLElement;
        let geometry: any;
        component.scroller.visitMountedGeometry((row: any) => {
          if (row.el === host) geometry = row;
        });
        const viewport = document.querySelector(
          '.pane-fg .msg-viewport',
        ) as HTMLElement;
        const composer = document.querySelector('.pane-fg app-chat-input')!;
        return {
          height: (el as HTMLElement).offsetHeight,
          modeled: geometry?.height === host.offsetHeight,
          aboveComposer:
            el.getBoundingClientRect().bottom <=
            composer.getBoundingClientRect().top + 1,
          atBottom:
            Math.abs(
              viewport.scrollHeight -
                viewport.clientHeight -
                viewport.scrollTop,
            ) <= 1,
        };
      }),
    )
    .toEqual({
      height: 40,
      modeled: true,
      aboveComposer: true,
      atBottom: true,
    });

  await page.evaluate(() => {
    const state = window as any;
    state.tailCountAnimations = 0;
    const animate = Element.prototype.animate;
    state.restoreTailAnimationProbe = () => {
      Element.prototype.animate = animate;
    };
    Element.prototype.animate = function (...args) {
      if (this.closest('app-tail-activity-row app-flip-count'))
        state.tailCountAnimations++;
      return animate.apply(this, args);
    };
    state.tailIndicator = document.querySelector(
      '.pane-fg .tail-self app-outbox-indicator',
    );
    state.releaseTailPosts[0]();
  });
  try {
    await expect(messages.locator('.current')).toHaveText('2');
    await expect
      .poll(() => page.evaluate(() => (window as any).tailCountAnimations))
      .toBe(2);
    await expect(dots).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => (window as any).tailScans.length))
      .toBe(1);
    await page.evaluate(() => {
      const state = window as any;
      state.releaseTailPosts[1]();
      state.releaseTailPosts[2]();
      return Promise.all(state.tailSends);
    });
    await expect(messages.locator('.current')).toHaveCount(0);
    await expect(dots).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as any).tailIndicator ===
          document.querySelector('.pane-fg .tail-self app-outbox-indicator'),
      ),
    ).toBe(true);
    await expect
      .poll(() => page.evaluate(() => (window as any).tailScans.length))
      .toBe(1);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const component = (window as any).ng.getComponent(
            document.querySelector('.pane-fg app-message-thread'),
          );
          return component.source.search('Tail interval verification', 50)
            .length;
        }),
      )
      .toBe(3);
    await expect(
      pane
        .locator('.msg-bubble-text')
        .filter({ hasText: 'Tail interval verification' }),
    ).toHaveCount(0);
    // Actual first history response was captured before later POSTs. Advancing a
    // deleted-only head makes that snapshot insufficient for today's gap end.
    await page.evaluate(() => {
      const component = (window as any).ng.getComponent(
        document.querySelector('.pane-fg app-message-thread'),
      );
      component.source.advanceDeletedHead(component.source.allocateMsgId() + 1);
      (window as any).tailScans[0].release();
    });
    await expect
      .poll(() => page.evaluate(() => (window as any).tailScans.length))
      .toBe(2);
    await expect(dots).toBeVisible();
    await page.evaluate(() => (window as any).tailScans[1].release());
    await expect(
      pane
        .locator('.msg-bubble-text')
        .filter({ hasText: 'Tail interval verification' }),
    ).toHaveCount(3);
    await expect(
      pane.locator('app-tail-activity-row .tail-activity-row'),
    ).toHaveCount(0);
    await expect(
      pane
        .locator('.msg-bubble-text')
        .filter({ hasText: 'Tail interval verification' })
        .last(),
    ).toBeInViewport();
  } finally {
    await page.evaluate(() => (window as any).restoreTailAnimationProbe());
  }
});
