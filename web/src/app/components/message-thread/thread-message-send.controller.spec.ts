import { describe, expect, it, vi } from 'vitest';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatMsgData } from '../message-cards/chat-item';
import type { MessageThreadAdapter } from './message-thread-adapter';
import type { MsgService } from '../../services/message.service';
import {
  ThreadMessageSendController,
  type ThreadMessageSendHost,
} from './thread-message-send.controller';

describe('ThreadMessageSendController', () => {
  it('builds and dispatches one optimistic text send', async () => {
    const sendText = vi.fn(async () => ({ code: 0, message: 'ok' }));
    const dispatch = vi.fn();
    const accept = vi.fn(async () => undefined);
    const item = {
      id: -1,
      clientMessageId: 'cid',
      data: { type: 'msg', text: 'hello' },
    } as unknown as CbItem<ChatMsgData>;
    const host = {
      threadId: () => 3,
      selfAccount: () => 'alice',
      consumeQuote: () => null,
      makeItem: () => item,
      newClientMessageId: () => 'cid',
      dispatch,
      source: () => ({}) as never,
      fail: vi.fn(),
      accept,
      surfaceFailure: vi.fn(),
    } satisfies ThreadMessageSendHost;
    new ThreadMessageSendController(
      { sendText } as unknown as MessageThreadAdapter,
      {} as MsgService,
      host,
    ).text(' hello ');
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith(item);
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 3, clientMessageId: 'cid' }),
    );
    expect(accept).toHaveBeenCalledWith(item);
  });
});
