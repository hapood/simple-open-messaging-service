import { describe, expect, it, vi } from 'vitest';
import type { ScrollerApi } from '../../lib/chat-box/chat-box-scroller';
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
      { account: 'alice', name: 'Alice' },
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
});
