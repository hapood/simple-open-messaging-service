import { test, expect } from '../fixtures/playground';

test('absorbed self media animates only the newly delivered cell', async ({ page }) => {
  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  await expect(page.locator('.pane-fg .msg-row').first()).toBeVisible();
  await page.evaluate(async () => {
    const component = (window as any).ng.getComponent(document.querySelector('.pane-fg app-message-thread'));
    await component.scroller.goToLatest();
    const state = (window as any);
    state.albumTestIds = [];
    state.pushAlbumTestImage = () => {
      const id = component.source.allocateMsgId();
      state.albumTestIds.push(id);
      component.source.pushLive([{
        id, boundary: 'newest', data: {
          type: 'msg', msgId: id, creator: JSON.stringify([0, 'user-1']), name: 'me', isSelf: true,
          text: '', time: '12:00', createdAtMs: Date.now(), contentType: 'IMAGE',
          images: [{ kind: 'image', src: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="60"/%3E', w: 100, h: 60, msgId: id }],
          file: null, status: 'sent', isGroupConversation: false,
        },
      }]);
    };
    state.pushAlbumTestImage();
  });
  await expect.poll(() => page.evaluate(() => {
    const id = (window as any).albumTestIds[0];
    return !!document.querySelector(`[data-media-message-id="${id}"]`);
  })).toBe(true);
  await page.evaluate(async () => {
    const state = window as any;
    const component = state.ng.getComponent(document.querySelector('.pane-fg app-message-thread'));
    await component.scroller.goToLatest();
    state.albumPaintTargets = [];
    const animate = Element.prototype.animate;
    state.restoreAlbumAnimationProbe = () => { Element.prototype.animate = animate; };
    Element.prototype.animate = function (...args) {
      const id = this.getAttribute('data-media-message-id');
      if (id) state.albumPaintTargets.push(Number(id));
      return animate.apply(this, args);
    };
    state.pushAlbumTestImage();
  });
  await expect.poll(() => page.evaluate(() => {
    const state = window as any;
    return state.albumPaintTargets.includes(state.albumTestIds[1]);
  })).toBe(true);
  const result = await page.evaluate(() => {
    const state = window as any;
    const component = state.ng.getComponent(document.querySelector('.pane-fg app-message-thread'));
    state.restoreAlbumAnimationProbe();
    return {
      oldAnimated: state.albumPaintTargets.includes(state.albumTestIds[0]),
      sameHost: component.scroller.getMountedGeometry(state.albumTestIds[0]).el ===
        component.scroller.getMountedGeometry(state.albumTestIds[1]).el,
    };
  });
  expect(result).toEqual({ oldAnimated: false, sameHost: true });
});
