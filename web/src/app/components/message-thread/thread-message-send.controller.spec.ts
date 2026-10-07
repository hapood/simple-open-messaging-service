import { describe, expect, it, vi } from 'vitest';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatMsgData } from '../message-cards/chat-item';
import type {
  MessageThreadAdapter,
  MessageThreadSource,
} from './message-thread-adapter';
import {
  ThreadMessageSendController,
  type ThreadMessageSendHost,
} from './thread-message-send.controller';
import { MESSAGE_SEND_TIMEOUT_MS } from './message-send-timeout';

describe('ThreadMessageSendController', () => {
  it('fails a text send when the HTTP/IPC promise never settles', async () => {
    vi.useFakeTimers();
    try {
      const fail = vi.fn(async () => undefined);
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
        dispatch: vi.fn(),
        source: () => ({}) as never,
        fail,
        accept: vi.fn(),
        surfaceFailure: vi.fn(),
      } satisfies ThreadMessageSendHost;
      new ThreadMessageSendController(
        {
          sendText: () => new Promise(() => undefined),
        } as unknown as MessageThreadAdapter,
        host,
      ).text('hello');
      await vi.advanceTimersByTimeAsync(MESSAGE_SEND_TIMEOUT_MS);
      expect(fail).toHaveBeenCalledWith(item);
      expect(host.accept).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

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
      host,
    ).text(' hello ');
    await vi.waitFor(() => expect(accept).toHaveBeenCalledWith(item));
    expect(dispatch).toHaveBeenCalledWith(item);
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 3, clientMessageId: 'cid' }),
    );
    expect(accept).toHaveBeenCalledWith(item);
  });

  it('routes a contact card through the thread adapter with its optimistic item', async () => {
    const sendContact = vi.fn(async () => ({ code: 0, message: 'ok' }));
    const item = {
      id: -1,
      clientMessageId: 'contact-cid',
      data: { type: 'msg', contentType: 'CONTACT_CARD' },
    } as unknown as CbItem<ChatMsgData>;
    const source = {} as MessageThreadSource;
    const host = {
      threadId: () => 3,
      selfAccount: () => 'alice',
      consumeQuote: () => null,
      makeItem: vi.fn(() => item),
      newClientMessageId: () => 'contact-cid',
      dispatch: vi.fn(),
      source: () => source,
      fail: vi.fn(async () => undefined),
      accept: vi.fn(async () => undefined),
      surfaceFailure: vi.fn(),
    } satisfies ThreadMessageSendHost;

    new ThreadMessageSendController(
      { sendContact } as unknown as MessageThreadAdapter,
      host,
    ).contact({
      kind: 'contact',
      target: {
        account: 'maya',
        namespaceId: 0,
        profileRev: 2,
      },
      account: 'maya',
      domain: 'chat.example.test',
      name: 'Maya',
      avatar: '',
      bio: '',
    });
    await vi.waitFor(() => expect(host.accept).toHaveBeenCalledWith(item));

    expect(host.dispatch).toHaveBeenCalledWith(item);
    expect(sendContact).toHaveBeenCalledWith({
      threadId: 3,
      target: {
        account: 'maya',
        namespaceId: 0,
        profileRev: 2,
      },
      clientMessageId: 'contact-cid',
      optimistic: item,
      source,
    });
    expect(host.accept).toHaveBeenCalledWith(item);
  });
});
