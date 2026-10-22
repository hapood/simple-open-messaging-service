import { test, expect } from '../fixtures/playground';

test('reply composer reserves local space through a global height reset', async ({
  page,
}) => {
  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  const pane = page.locator('.pane-layer.pane-fg');
  await expect(pane.locator('.cb-tail-cap--gap')).toBeAttached();
  // The initial backfill changes scrollTop and dismisses open menus; wait for that page first.
  await expect
    .poll(() =>
      pane.locator('.msg-content').evaluate((content) => content.scrollHeight),
    )
    .toBeGreaterThan(6000);
  await pane.locator('.msg-bubble-text').last().click({ button: 'right' });
  await pane.getByRole('menuitem', { name: 'Reply', exact: true }).click();
  await expect(pane.locator('.msg-compose-quote')).toBeVisible();
  const geometry = await pane.evaluate((element) => {
    const tail = element.querySelector<HTMLElement>('.cb-tail-cap')!;
    const composer = element.querySelector<HTMLElement>('app-chat-input')!;
    const viewport = element.querySelector<HTMLElement>('.msg-viewport')!;
    const root = document.documentElement.style;
    const previous = root.getPropertyValue('--soms-composer-height');
    const measure = () => ({
      tail: tail.offsetHeight,
      scrollTop: viewport.scrollTop,
    });
    const before = measure();
    try {
      root.setProperty('--soms-composer-height', '0px');
      return {
        before,
        during: measure(),
        composerHeight: composer.offsetHeight,
      };
    } finally {
      root.setProperty('--soms-composer-height', previous);
    }
  });
  expect(geometry.during).toEqual(geometry.before);
  expect(geometry.during.tail).toBeGreaterThanOrEqual(geometry.composerHeight);
  await pane.locator('.msg-compose-quote-close').click();
  await expect(pane.locator('.msg-compose-quote')).toHaveCount(0);
});

type ComposerFrame = {
  thread: string;
  messageBottom: number;
  composerTop: number;
};

type ComposerProbe = {
  frames: number;
  overlaps: ComposerFrame[];
  raf: number;
};

type ProbeWindow = Window & { composerProbe?: ComposerProbe };

for (const width of [1440, 1000]) {
  test(`thread switches at ${width}px keep messages above the floating composer on every frame`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => {
      const probe: ComposerProbe = { frames: 0, overlaps: [], raf: 0 };
      (window as ProbeWindow).composerProbe = probe;
      const sample = () => {
        const pane = document.querySelector('.pane-layer.pane-fg');
        const tail = pane?.querySelector<HTMLElement>('.cb-tail-cap--gap');
        const message = tail?.previousElementSibling;
        const composer = pane?.querySelector<HTMLElement>('app-chat-input');
        if (
          message &&
          !message.classList.contains('msg-sentinel') &&
          composer
        ) {
          probe.frames++;
          const frame = {
            thread: pane?.querySelector('.msg-header')?.textContent ?? '',
            messageBottom: message.getBoundingClientRect().bottom,
            composerTop: composer.getBoundingClientRect().top,
          };
          if (frame.messageBottom > frame.composerTop + 1)
            probe.overlaps.push(frame);
        }
        probe.raf = requestAnimationFrame(sample);
      };
      sample();
    });

    // Revisit both resident slots after their kernels idle: exercise both activation orders,
    // not just the first mount, and keep observing through the asynchronous history backfill.
    for (const name of ['Alice', 'Liam', 'Alice', 'Liam', 'Alice']) {
      await page
        .getByRole('button', { name: new RegExp(`^${name}, chat`) })
        .click();
      await expect(
        page.locator('.pane-layer.pane-fg .msg-header'),
      ).toContainText(name);
      await expect(
        page.locator('.pane-layer.pane-fg .cb-tail-cap--gap'),
      ).toBeAttached();
      await expect(
        page.locator('.pane-layer:not(.pane-fg) .cb-tail-cap'),
      ).toHaveCount(0);
    }

    const probe = await page.evaluate(() => {
      const probe = (window as ProbeWindow).composerProbe!;
      cancelAnimationFrame(probe.raf);
      return probe;
    });
    expect(probe.frames).toBeGreaterThan(0);
    expect(probe.overlaps).toEqual([]);
  });
}

test('pane tail geometry is independent of a transient global composer height', async ({
  page,
}) => {
  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  await expect(
    page.locator('.pane-layer.pane-fg .cb-tail-cap--gap'),
  ).toBeAttached();

  // Exercise the actual CSS cascade in Chromium. Force layout between the same-task root
  // reset/restore that can occur during A/B handoff; ResizeObserver may see no net size change.
  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const container = document.querySelector<HTMLElement>(
      '.pane-layer.pane-fg .msg-container',
    )!;
    const viewport = container.querySelector<HTMLElement>('.msg-viewport')!;
    const tail = container.querySelector<HTMLElement>('.cb-tail-cap')!;
    const oldValue = root.style.getPropertyValue('--soms-composer-height');
    const measure = () => ({
      tail: tail.offsetHeight,
      scrollTop: viewport.scrollTop,
    });
    const before = measure();
    let during: ReturnType<typeof measure>;
    try {
      root.style.setProperty('--soms-composer-height', '0px');
      during = measure();
    } finally {
      root.style.setProperty('--soms-composer-height', oldValue);
    }
    return { before, during, after: measure() };
  });
  expect(geometry.before.tail).toBeGreaterThan(0);
  expect(geometry.before.scrollTop).toBeGreaterThan(0);
  expect(geometry.during).toEqual(geometry.before);
  expect(geometry.after).toEqual(geometry.before);
});
