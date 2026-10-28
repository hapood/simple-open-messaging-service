import type { ConversationItem } from '../../../web/src/app/services/model';
import { test, expect } from '../fixtures/playground';

type AnimationRecord = {
  key: string | null;
  outgoing: boolean;
  frames: Keyframe[];
};

type ProbeWindow = Window & {
  ng: { getComponent(element: Element): unknown };
  threadListAnimations: AnimationRecord[];
};

type PlaygroundControls = {
  conversations: {
    items(): ConversationItem[];
    setRelatedConversations(items: ConversationItem[]): void;
    applyThreadMeta(threadId: number, patch: Partial<ConversationItem>): void;
  };
};

test('5000 conversations keep a bounded DOM and animate business changes, not window recycling', async ({
  page,
}) => {
  await page.evaluate(() => {
    const probe = window as unknown as ProbeWindow;
    probe.threadListAnimations = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      if (this.classList.contains('thread-item')) {
        probe.threadListAnimations.push({
          key: this.getAttribute('data-flip-key'),
          outgoing: this.getAttribute('aria-hidden') === 'true',
          frames: frames as Keyframe[],
        });
      }
      return animate.call(this, frames, options);
    };
    // The fixture serves the development playground. Use Angular's debug API
    // instead of adding a production-only seed or inspection surface.
    const controls = probe.ng.getComponent(
      document.querySelector('app-playground-controls')!,
    ) as PlaygroundControls;
    const base = controls.conversations
      .items()
      .find((item) => item.type === 'P2P')!;
    for (const item of controls.conversations.items()) {
      if (item.pinned)
        controls.conversations.applyThreadMeta(item.threadId, {
          pinned: false,
        });
    }
    controls.conversations.setRelatedConversations(
      Array.from({ length: 5000 }, (_, index) => ({
        ...base,
        threadId: 10000 + index,
        pinned: index === 0,
        pinnedAt: index === 0 ? Date.now() : null,
        profile: { ...base.profile, name: `Virtual conversation ${index}` },
      })),
    );
  });

  const viewport = page.locator('app-thread-list .thread-list');
  const rows = viewport.locator('[data-flip-key]');
  await expect(viewport.locator('.thread-slot').first()).toHaveAttribute(
    'aria-setsize',
    /^50\d\d$/,
  );
  const count = Number(
    await viewport.locator('.thread-slot').first().getAttribute('aria-setsize'),
  );
  await expect.poll(() => rows.count()).toBeLessThan(40);
  const geometry = await viewport.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    height: element.clientHeight,
    rowHeights: Array.from(
      element.querySelectorAll<HTMLElement>('[data-flip-key]'),
    ).map((row) => row.offsetHeight),
  }));
  expect(geometry.scrollHeight).toBe(count * 72);
  expect(geometry.rowHeights.every((height) => height === 72)).toBe(true);

  await expect
    .poll(() => viewport.locator('[aria-hidden="true"].thread-item').count())
    .toBe(0);
  await page.evaluate(() => {
    (window as unknown as ProbeWindow).threadListAnimations = [];
  });
  await viewport.evaluate((element) => {
    element.scrollTop = 2000 * 72;
  });
  await expect(viewport.locator('.thread-slot').first()).toHaveAttribute(
    'aria-posinset',
    '1995',
  );
  await expect.poll(() => rows.count()).toBeLessThan(40);
  expect(
    await page.evaluate(
      () => (window as unknown as ProbeWindow).threadListAnimations,
    ),
  ).toEqual([]);

  await viewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(viewport.locator('.thread-slot').first()).toHaveAttribute(
    'aria-posinset',
    '1',
  );
  await page.evaluate(() => {
    const probe = window as unknown as ProbeWindow;
    probe.threadListAnimations = [];
    const controls = probe.ng.getComponent(
      document.querySelector('app-playground-controls')!,
    ) as PlaygroundControls;
    // This row is near the end of the complete list and has no mounted DOM.
    controls.conversations.applyThreadMeta(10001, {
      lastMessageAt: Date.now(),
    });
  });
  await expect(rows.nth(0)).toHaveAttribute('data-flip-key', '10000');
  await expect(rows.nth(1)).toHaveAttribute('data-flip-key', '10001');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as ProbeWindow).threadListAnimations.some(
          (record) =>
            record.key === '10001' &&
            record.frames[0].opacity === 0 &&
            record.frames[0].transform === 'translateX(-32px)',
        ),
      ),
    )
    .toBe(true);
  const records = await page.evaluate(
    () => (window as unknown as ProbeWindow).threadListAnimations,
  );
  expect(
    records.some(
      (record) => record.frames[0].transform === 'translateY(-72px)',
    ),
  ).toBe(true);
  expect(records.some((record) => record.outgoing)).toBe(false);

  // Pin the now-visible row. Its old visual exits while the same keyed row
  // enters the first slot, without touching the window's positioning transform.
  await page.evaluate(() => {
    const probe = window as unknown as ProbeWindow;
    probe.threadListAnimations = [];
    const controls = probe.ng.getComponent(
      document.querySelector('app-playground-controls')!,
    ) as PlaygroundControls;
    controls.conversations.applyThreadMeta(10001, {
      pinned: true,
      pinnedAt: Date.now() + 1000,
    });
  });
  await expect(rows.first()).toHaveAttribute('data-flip-key', '10001');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as ProbeWindow).threadListAnimations.some(
          (record) =>
            record.outgoing &&
            record.frames[1].opacity === 0 &&
            record.frames[1].transform === 'translateX(32px)',
        ),
      ),
    )
    .toBe(true);
  expect(await viewport.evaluate((element) => element.scrollHeight)).toBe(
    count * 72,
  );
});
