import { describe, expect, it, vi } from 'vitest';
import type { CbItem, ScrollerApi } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from '../message-cards/chat-item';
import type { MessageThreadSource } from './message-thread-adapter';
import { ThreadOptimisticController } from './thread-optimistic.controller';

function harness(noNewer: boolean) {
  const source = {
    addPending: vi.fn(),
  } as unknown as MessageThreadSource;
  const scroller = {
    getInfo: () => ({ noNewer, newestId: 42 }),
    insertAfter: vi.fn(() => true),
    scrollToBottom: vi.fn(),
  } as unknown as ScrollerApi<ChatItemData>;
  const controller = new ThreadOptimisticController(() => -7);
  controller.bind(scroller, source);
  return { controller, source, scroller };
}

describe('ThreadOptimisticController', () => {
  it('builds a pending item with one stable placeholder identity', () => {
    const { controller } = harness(true);
    const item = controller.makeItem(
      'client-id',
      { account: 'alice', name: 'Alice', domain: 'chat.test', namespaceId: 0 },
      false,
      'hello',
      'PURE_TEXT',
      [{ kind: 'image', src: 'blob:test', w: 1, h: 1 }],
      null,
    );
    expect(item.id).toBe(-7);
    expect(item.data.msgId).toBe(-7);
    expect(item.data.images?.[0].msgId).toBe(-7);
    expect(item.data.status).toBe('sending');
  });

  it('queues away from the newest end and drains once it is mounted', () => {
    const { controller, source, scroller } = harness(false);
    const item = { id: -1, data: { type: 'server-gap' } } as never;
    controller.dispatch(item);
    expect(source.addPending).not.toHaveBeenCalled();
    controller.drainAtNewest(true);
    expect(source.addPending).toHaveBeenCalledWith(item);
    expect(scroller.insertAfter).toHaveBeenCalledWith(42, item, {
      optimistic: true,
    });
  });

  it('fails an accepted message only when its delivery echo is still missing', async () => {
    vi.useFakeTimers();
    try {
      const { controller, source, scroller } = harness(true);
      const item = {
        id: -1,
        clientMessageId: 'cid',
        data: { type: 'msg', status: 'sending' },
      } as unknown as CbItem<ChatItemData>;
      source.markPendingAccepted = vi.fn(() => true);
      source.pendingByClientMessageId = vi.fn(() => ({
        ...item,
        data: { ...item.data, status: 'accepted' },
      })) as never;
      source.failPending = vi.fn(() => true);
      scroller.reconcilePending = vi.fn(async () => undefined) as never;
      await controller.accept(item);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(source.failPending).toHaveBeenCalledWith('cid');
      expect(scroller.reconcilePending).toHaveBeenCalledTimes(2);
      controller.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it('notifies the transfer owner when an accepted send is unconfirmed', async () => {
    vi.useFakeTimers();
    try {
      const { source, scroller } = harness(true);
      const notify = vi.fn();
      const controller = new ThreadOptimisticController(() => -1, notify);
      controller.bind(scroller, source);
      const item = {
        id: -1,
        clientMessageId: 'cid',
        data: { type: 'msg' },
      } as CbItem<ChatItemData>;
      source.markPendingAccepted = vi.fn(() => true);
      let status: 'accepted' | 'failed' = 'accepted';
      source.pendingByClientMessageId = vi.fn(() => ({
        ...item,
        data: { ...item.data, status },
      })) as never;
      source.failPending = vi.fn(() => {
        status = 'failed';
        return true;
      });
      scroller.reconcilePending = vi.fn(async () => undefined) as never;
      await controller.accept(item);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(notify).toHaveBeenCalledWith('cid');
      controller.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a confirmation timer when an accepted send is remounted', async () => {
    vi.useFakeTimers();
    try {
      const { source, scroller } = harness(true);
      const item = {
        id: -1,
        clientMessageId: 'voice-cid',
        data: { type: 'msg', status: 'accepted' },
      } as CbItem<ChatItemData>;
      source.acceptedPending = vi.fn(() => [item]);
      source.pendingByClientMessageId = vi.fn(() => item);
      source.failPending = vi.fn(() => true);
      scroller.reconcilePending = vi.fn(async () => undefined) as never;
      const controller = new ThreadOptimisticController(() => -1);
      controller.bind(scroller, source);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(source.failPending).toHaveBeenCalledWith('voice-cid');
      controller.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the shared outbox failed when a timeout arrives after leaving the thread', async () => {
    const failDetached = vi.fn();
    const controller = new ThreadOptimisticController(
      () => -1,
      undefined,
      failDetached,
    );
    const { source, scroller } = harness(true);
    controller.bind(scroller, source);
    controller.reset();
    await controller.fail({
      id: -1,
      clientMessageId: 'old-thread-cid',
      data: { type: 'msg' },
    } as CbItem<ChatItemData>);
    expect(failDetached).toHaveBeenCalledWith('old-thread-cid');
  });
});
