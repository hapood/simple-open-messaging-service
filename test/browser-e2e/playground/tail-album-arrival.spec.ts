import { test, expect } from '../fixtures/playground';

test('absorbed self media appears immediately without replaying cell entry animations', async ({
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
      state.albumTestIds = [];
      // Fixed timestamp keeps the two deliveries in one album even on slow workers.
      const createdAtMs = Date.now();
      state.pushAlbumTestImage = () => {
        const id = component.source.allocateMsgId();
        state.albumTestIds.push(id);
        component.source.pushLive([
          {
            id,
            data: {
              type: 'msg',
              msgId: id,
              creator: JSON.stringify([0, 'user-1']),
              name: 'me',
              isSelf: true,
              text: '',
              time: '12:00',
              createdAtMs,
              contentType: 'IMAGE',
              images: [
                {
                  kind: 'image',
                  src: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="60"/%3E',
                  w: 100,
                  h: 60,
                  msgId: id,
                },
              ],
              file: null,
              isGroupConversation: false,
            },
          },
        ]);
      };
      state.pushAlbumTestImage();
      return jumped;
    }),
  ).toBe(true);
  const firstId = await page.evaluate(() => (window as any).albumTestIds[0]);
  await expect(
    pane.locator(`[data-media-message-id="${firstId}"]`),
  ).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const state = window as any;
      const component = state.ng.getComponent(
        document.querySelector('.pane-fg app-message-thread'),
      );
      const jumped = await component.scroller.goToLatest();
      state.albumHost = component.scroller.getMountedGeometry(
        state.albumTestIds[0],
      ).el;
      state.albumOldCell = document.querySelector(
        `[data-media-message-id="${state.albumTestIds[0]}"]`,
      );
      state.albumPaintTargets = [];
      state.albumFrames = [];
      const animate = Element.prototype.animate;
      state.restoreAlbumAnimationProbe = () => {
        Element.prototype.animate = animate;
        cancelAnimationFrame(state.albumRaf);
      };
      Element.prototype.animate = function (...args) {
        const id = this.getAttribute('data-media-message-id');
        if (id) state.albumPaintTargets.push(Number(id));
        return animate.apply(this, args);
      };
      const sample = () => {
        const cells = state.albumTestIds.map(
          (id: number) =>
            document.querySelector(
              `[data-media-message-id="${id}"]`,
            ) as HTMLElement | null,
        );
        if (cells.length === 2 && cells.every(Boolean)) {
          state.albumFrames.push(
            cells.map((cell: HTMLElement) => ({
              height: cell.offsetHeight,
              cssHeight: parseFloat(getComputedStyle(cell).height),
              cssTop: parseFloat(getComputedStyle(cell).top),
              opacity: getComputedStyle(cell).opacity,
              transform: getComputedStyle(cell).transform,
              animations: cell.getAnimations().map((animation) => ({
                type: animation.constructor.name,
                property:
                  animation instanceof CSSTransition
                    ? animation.transitionProperty
                    : null,
              })),
              allocation: cell.parentElement!.offsetHeight,
            })),
          );
        }
        state.albumRaf = requestAnimationFrame(sample);
      };
      sample();
      state.pushAlbumTestImage();
      return jumped;
    }),
  ).toBe(true);
  try {
    const secondId = await page.evaluate(() => (window as any).albumTestIds[1]);
    await expect(
      pane.locator(`[data-media-message-id="${secondId}"]`),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => (window as any).albumFrames.length))
      .toBeGreaterThanOrEqual(3);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window as any;
          const component = state.ng.getComponent(
            document.querySelector('.pane-fg app-message-thread'),
          );
          const first = component.scroller.getMountedGeometry(
            state.albumTestIds[0],
          );
          const second = component.scroller.getMountedGeometry(
            state.albumTestIds[1],
          );
          const composer = document.querySelector('.pane-fg app-chat-input')!;
          const viewport = document.querySelector(
            '.pane-fg .msg-viewport',
          ) as HTMLElement;
          return {
            sameHost:
              !!first &&
              !!second &&
              first.el === second.el &&
              first.el === state.albumHost,
            oldCellRetained:
              document.querySelector(
                `[data-media-message-id="${state.albumTestIds[0]}"]`,
              ) === state.albumOldCell,
            cells: first?.el.querySelectorAll('[data-media-message-id]').length,
            modeled:
              !!first &&
              first.height === first.el.offsetHeight &&
              Number.isInteger(first.height),
            aboveComposer:
              !!first &&
              first.el.getBoundingClientRect().bottom <=
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
        sameHost: true,
        oldCellRetained: true,
        cells: 2,
        modeled: true,
        aboveComposer: true,
        atBottom: true,
      });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window as any;
          return state.albumTestIds.every((id: number) => {
            const cell = document.querySelector(
              `[data-media-message-id="${id}"]`,
            ) as HTMLElement;
            const target = state.ng.getComponent(cell).rect();
            return (
              parseFloat(getComputedStyle(cell).height) === target.hPx &&
              parseFloat(getComputedStyle(cell).top) === target.yPx &&
              cell.getAnimations().length === 0
            );
          });
        }),
      )
      .toBe(true);
    const result = await page.evaluate(() => {
      const state = window as any;
      return { targets: state.albumPaintTargets, frames: state.albumFrames };
    });
    expect(result.targets).toEqual([]);
    expect(result.frames.length).toBeGreaterThanOrEqual(3);
    // Absorption must still animate internal resizing, not fade/scale either
    // body. The final outer allocation stays fixed throughout those frames.
    expect(
      result.frames.some((frame: any[]) =>
        frame[0].animations.some(
          (animation: any) => animation.property === 'width',
        ),
      ),
    ).toBe(true);
    expect(
      new Set(result.frames.map((frame: any[]) => frame[0].cssHeight)).size,
    ).toBeGreaterThan(1);
    expect(
      new Set(result.frames.map((frame: any[]) => frame[0].allocation)).size,
    ).toBe(1);
    for (const frame of result.frames) {
      expect(frame).toHaveLength(2);
      for (const cell of frame) {
        expect(cell.height).toBeGreaterThan(0);
        expect(Number.isInteger(cell.height)).toBe(true);
        expect(Number.isInteger(cell.cssHeight)).toBe(true);
        expect(Number.isInteger(cell.cssTop)).toBe(true);
        expect(cell).toMatchObject({ opacity: '1', transform: 'none' });
        for (const animation of cell.animations) {
          expect(animation.type).toBe('CSSTransition');
          expect(['left', 'width']).toContain(animation.property);
        }
      }
    }
  } finally {
    await page.evaluate(() => (window as any).restoreAlbumAnimationProbe());
  }
});
