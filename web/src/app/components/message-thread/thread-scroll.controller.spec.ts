import { describe, expect, it } from 'vitest';
import type { CbScrollInfo } from '../../lib/chat-box/chat-box-scroller';
import { ThreadScrollController } from './thread-scroll.controller';

const info = (overrides: Partial<CbScrollInfo> = {}): CbScrollInfo =>
  ({
    scrollTop: 0,
    scrollHeight: 500,
    viewportHeight: 100,
    oldestId: 1,
    newestId: 10,
    mounted: 10,
    atTop: true,
    atBottom: false,
    noOlder: false,
    noNewer: false,
    ...overrides,
  }) as CbScrollInfo;

describe('ThreadScrollController', () => {
  it('counts newer messages only while the viewport is away from the bottom', () => {
    const controller = new ThreadScrollController();
    controller.update(info(), undefined);
    controller.noteNewerAvailable();
    expect(controller.newMessageCount()).toBe(1);
    controller.update(info({ scrollTop: 400, noNewer: true }), undefined);
    expect(controller.newMessageCount()).toBe(0);
  });

  it('emits a deferred unread reanchor once its sequence is mounted', () => {
    const controller = new ThreadScrollController();
    controller.open(5);
    controller.markUnreadReanchorNeeded();
    expect(controller.update(info(), undefined)).toBe(5);
    expect(controller.update(info(), undefined)).toBeNull();
  });
});
