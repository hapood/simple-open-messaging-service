import { describe, expect, it } from 'vitest';
import type { CbScrollInfo } from '../../lib/chat-box/chat-box-scroller';
import { ThreadScrollController } from './thread-scroll.controller';

const info = (overrides: Partial<CbScrollInfo> = {}): CbScrollInfo => ({
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
});

describe('ThreadScrollController', () => {
  it('tracks the exact pin fact separately and resets it without changing the entry boundary', () => {
    const controller = new ThreadScrollController();
    controller.open(5);
    controller.update(
      info({ scrollTop: 400, noNewer: true }),
      undefined,
      false,
    );
    expect(controller.atBottom()).toBe(true);
    expect(controller.pinnedToBottom()).toBe(false);
    controller.update(info(), undefined, true);
    expect(controller.pinnedToBottom()).toBe(true);
    expect(controller.firstUnreadSeq).toBe(5);
    controller.reset();
    expect(controller.pinnedToBottom()).toBe(false);
  });
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
