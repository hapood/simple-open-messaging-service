import type { Locator } from '@playwright/test';
import { test, expect } from '../fixtures/playground';

// The playground exposes Angular's development inspector. Ordinary conversation
// entry restores readSeq (or history start); geometry at the tail needs an explicit jump.
type MessageThread = {
  scroller?: {
    goToLatest(): Promise<boolean>;
    isPinnedToBottom(): boolean;
  };
};
type PlaygroundWindow = Window & {
  ng: { getComponent(element: Element): MessageThread };
};

async function goToLatest(pane: Locator): Promise<void> {
  await expect(pane.locator('.msg-viewport')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(pane.locator('.msg-row').first()).toBeAttached();
  const jumped = await pane
    .locator('app-message-thread')
    .evaluate((element) => {
      const component = (window as unknown as PlaygroundWindow).ng.getComponent(
        element,
      );
      return component.scroller!.goToLatest();
    });
  expect(jumped).toBe(true);
  await expect(pane.locator('.msg-viewport')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect
    .poll(() =>
      pane.locator('app-message-thread').evaluate((element) => {
        const component = (
          window as unknown as PlaygroundWindow
        ).ng.getComponent(element);
        return component.scroller!.isPinnedToBottom();
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      pane
        .locator('.msg-viewport')
        .evaluate((viewport) =>
          Math.abs(
            viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
          ),
        ),
    )
    .toBeLessThanOrEqual(1);
}

test('reply composer reserves local space through a global height reset', async ({
  page,
}) => {
  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  const pane = page.locator('.pane-layer.pane-fg');
  await expect(pane.locator('.cb-bottom-reserve')).toBeAttached();
  // Finish navigation before opening a menu: replacing the window dismisses it.
  await goToLatest(pane);
  await pane.locator('.msg-bubble-text').last().click({ button: 'right' });
  await pane.getByRole('menuitem', { name: 'Reply', exact: true }).click();
  await expect(pane.locator('.msg-compose-quote')).toBeVisible();
  const geometry = await pane.evaluate((element) => {
    const tail = element.querySelector<HTMLElement>('.cb-bottom-reserve')!;
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

for (const width of [1440, 1000]) {
  test(`explicit latest positioning at ${width}px reserves the full composer height`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole('button', { name: /^Alice, chat/ }).click();
    const pane = page.locator('.pane-layer.pane-fg');
    await expect(pane.locator('app-chat-input')).toBeVisible();
    // The responsive breakpoint belongs to the composer, not the whole window.
    // At 1000px the conversation list leaves a compact chat pane; 1440px is wide.
    await expect
      .poll(() =>
        pane.locator('app-chat-input').evaluate((el) => ({
          wide: el.clientWidth >= 720,
          height: (el as HTMLElement).offsetHeight,
        })),
      )
      .toEqual({ wide: width === 1440, height: width === 1440 ? 82 : 64 });
    await goToLatest(pane);

    await expect
      .poll(() =>
        pane.evaluate((element) => {
          const composer =
            element.querySelector<HTMLElement>('app-chat-input')!;
          const tail =
            element.querySelector<HTMLElement>('.cb-bottom-reserve')!;
          const message = tail.previousElementSibling!;
          const viewport = element.querySelector<HTMLElement>('.msg-viewport')!;
          return {
            reservesComposer: tail.offsetHeight >= composer.offsetHeight,
            messageVisible:
              message.getBoundingClientRect().bottom <=
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
        reservesComposer: true,
        messageVisible: true,
        atBottom: true,
      });
  });
}

type ComposerFrame = {
  thread: string;
  messageBottom: number;
  composerTop: number;
  reserveHeight: number;
  composerHeight: number;
  backgroundReserves: number;
  pinned: boolean;
};

type ComposerProbe = {
  frames: number;
  readingFrames: number;
  pinnedFrames: number;
  phase: 'entry' | 'latest';
  overlaps: ComposerFrame[];
  reserveViolations: ComposerFrame[];
  unpinnedFrames: ComposerFrame[];
  raf: number;
};

type ProbeWindow = Window & { composerProbe?: ComposerProbe };

for (const width of [1440, 1000]) {
  test(`thread switches at ${width}px keep messages above the floating composer on every frame`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    // Liam is blocked in the seed. Geometry needs two active message kernels; unblock
    // through the UI rather than changing the blocked-conversation fixture contract.
    await page.getByRole('button', { name: /^Liam, chat/ }).click();
    const activePane = page.locator('.pane-layer.pane-fg');
    await expect(activePane.locator('.msg-blocked-banner')).toBeVisible();
    await activePane
      .getByRole('button', { name: 'More options', exact: true })
      .click();
    const profile = page.locator('app-peer-profile');
    const block = profile.locator('.block-card').getByRole('switch');
    await expect(block).toBeChecked();
    await block.click();
    await expect(block).not.toBeChecked();
    await expect(activePane.locator('.cb-bottom-reserve')).toBeAttached();
    await profile.locator('.page-header__back').click();
    await expect(profile).toHaveCount(0);
    await page.evaluate(() => {
      const probe: ComposerProbe = {
        frames: 0,
        readingFrames: 0,
        pinnedFrames: 0,
        phase: 'entry',
        overlaps: [],
        reserveViolations: [],
        unpinnedFrames: [],
        raf: 0,
      };
      (window as ProbeWindow).composerProbe = probe;
      const sample = () => {
        const pane = document.querySelector('.pane-layer.pane-fg');
        const tail = pane?.querySelector<HTMLElement>('.cb-bottom-reserve');
        const message = tail?.previousElementSibling;
        const composer = pane?.querySelector<HTMLElement>('app-chat-input');
        if (
          message &&
          !message.classList.contains('msg-sentinel') &&
          composer
        ) {
          probe.frames++;
          const component = (
            window as unknown as PlaygroundWindow
          ).ng.getComponent(pane!.querySelector('app-message-thread')!);
          const pinned = component.scroller?.isPinnedToBottom() ?? false;
          const frame: ComposerFrame = {
            thread: pane?.querySelector('.msg-header')?.textContent ?? '',
            messageBottom: message.getBoundingClientRect().bottom,
            composerTop: composer.getBoundingClientRect().top,
            reserveHeight: tail!.offsetHeight,
            composerHeight: composer.offsetHeight,
            backgroundReserves: document.querySelectorAll(
              '.pane-layer:not(.pane-fg) .cb-bottom-reserve',
            ).length,
            pinned,
          };
          // Reserve ownership applies even while reading history. The last mounted
          // row can be far below the viewport then; that is not composer overlap.
          if (
            frame.reserveHeight < frame.composerHeight ||
            frame.backgroundReserves !== 0
          )
            probe.reserveViolations.push(frame);
          if (pinned || probe.phase === 'latest') {
            if (frame.messageBottom > frame.composerTop + 1)
              probe.overlaps.push(frame);
          }
          if (probe.phase === 'latest') {
            // Do not silently filter a regression that loses bottom pinning.
            if (!pinned) probe.unpinnedFrames.push(frame);
            probe.pinnedFrames++;
          } else if (!pinned) {
            probe.readingFrames++;
          }
        }
        probe.raf = requestAnimationFrame(sample);
      };
      sample();
    });

    // Revisit both resident slots in both activation orders. Unbinding releases
    // their windows, so each ordinary re-entry must explicitly navigate to latest.
    // The probe remains running through entry/loading, navigation, and bottom frames.
    for (const [visit, name] of [
      'Liam',
      'Alice',
      'Liam',
      'Alice',
      'Liam',
      'Alice',
    ].entries()) {
      await page.evaluate(() => {
        (window as ProbeWindow).composerProbe!.phase = 'entry';
      });
      // Liam is already open after unblocking. Selecting the active list item
      // toggles the chat closed; only subsequent visits are actual switches.
      if (visit > 0) {
        await page
          .getByRole('button', { name: new RegExp(`^${name}, chat`) })
          .click();
      }
      await expect(
        page.locator('.pane-layer.pane-fg .msg-header'),
      ).toContainText(name);
      await expect(
        page.locator('.pane-layer.pane-fg .cb-bottom-reserve'),
      ).toBeAttached();
      await expect(
        page.locator('.pane-layer:not(.pane-fg) .cb-bottom-reserve'),
      ).toHaveCount(0);
      await goToLatest(activePane);
      const observed = await page.evaluate(async () => {
        const probe = (window as ProbeWindow).composerProbe!;
        probe.phase = 'latest';
        const before = probe.pinnedFrames;
        // Observe actual paint opportunities, not a fixed-duration sleep. Every
        // visit must contribute bottom frames, including each reactivated slot.
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        return probe.pinnedFrames - before;
      });
      expect(
        observed,
        `${name} must contribute latest-position frames`,
      ).toBeGreaterThan(0);
    }

    const probe = await page.evaluate(() => {
      const probe = (window as ProbeWindow).composerProbe!;
      cancelAnimationFrame(probe.raf);
      return probe;
    });
    expect(probe.frames).toBeGreaterThan(0);
    expect(probe.readingFrames).toBeGreaterThan(0);
    expect(probe.pinnedFrames).toBeGreaterThan(0);
    expect(probe.reserveViolations).toEqual([]);
    expect(probe.unpinnedFrames).toEqual([]);
    expect(probe.overlaps).toEqual([]);
  });
}

test('pane tail geometry is independent of a transient global composer height', async ({
  page,
}) => {
  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  await expect(
    page.locator('.pane-layer.pane-fg .cb-bottom-reserve'),
  ).toBeAttached();
  await goToLatest(page.locator('.pane-layer.pane-fg'));

  // Exercise the actual CSS cascade in Chromium. Force layout between the same-task root
  // reset/restore that can occur during A/B handoff; ResizeObserver may see no net size change.
  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const container = document.querySelector<HTMLElement>(
      '.pane-layer.pane-fg .msg-container',
    )!;
    const viewport = container.querySelector<HTMLElement>('.msg-viewport')!;
    const tail = container.querySelector<HTMLElement>('.cb-bottom-reserve')!;
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
