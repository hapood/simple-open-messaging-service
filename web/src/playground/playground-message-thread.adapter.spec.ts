import { firstValueFrom } from 'rxjs';
import { vi } from 'vitest';
import type { CbItem } from '../app/lib/chat-box/chat-box-scroller';
import type { ChatItemData } from '../app/components/message-cards/chat-item';
import { MockItemSource } from '../app/pages/chatbox-playground/http-item-source.mock';
import type { ConversationItem } from '../app/services/model';
import { PlaygroundMessageThreadAdapter } from './playground-message-thread.adapter';

describe('PlaygroundMessageThreadAdapter', () => {
  it('confirms a contact card in the message sequence before the mock reply', async () => {
    const adapter = new PlaygroundMessageThreadAdapter();
    adapter.itemCount.set(10);
    adapter.sourceLatency.set(0);
    adapter.confirmDelay.set(0);
    adapter.pushSignalDelay.set(0);
    adapter.replyDelay.set(0);
    const source = adapter.createSource({ threadId: 1 } as ConversationItem, {
      onNewerAvailable: () => undefined,
      onMediaStatus: () => undefined,
    }) as MockItemSource;
    const optimistic: CbItem<ChatItemData> = {
      id: -1,
      clientMessageId: 'contact-1',
      data: {
        type: 'msg',
        msgId: -1,
        creator: JSON.stringify([0, 'mock.local', 'user-1']),
        isSelf: true,
        name: 'Me',
        text: JSON.stringify({ displayName: 'Maya', account: 'maya' }),
        time: '12:00',
        contentType: 'CONTACT_CARD',
        images: null,
        file: null,
        createdAtMs: Date.now(),
      },
    };
    source.addPending(optimistic);

    expect(
      (
        await adapter.sendContact({
          threadId: 1,
          target: {
            account: 'alice',
            namespaceId: 0,
            profileRev: 1,
          },
          clientMessageId: 'contact-1',
          optimistic,
          source,
        })
      ).code,
    ).toBe(0);
    await vi.waitFor(async () => {
      const items = await source.getNewer(10, 10);
      expect(items.length).toBe(2);
      expect(items[0].data.type).toBe('msg');
      expect(items[0].data.type === 'msg' && items[0].data.contentType).toBe(
        'CONTACT_CARD',
      );
      expect(items[1].data.type === 'msg' && items[1].data.isSelf).toBe(false);
      expect(source.getPending()).toHaveLength(0);
    });
  });

  it('marks group history and generates messages from multiple members', async () => {
    const adapter = new PlaygroundMessageThreadAdapter();
    adapter.itemCount.set(100);
    adapter.sourceLatency.set(0);
    adapter.groupSenderCount.set(3);
    const source = adapter.createSource(
      { threadId: 2, type: 'GROUP' } as ConversationItem,
      {
        onNewerAvailable: () => undefined,
        onMediaStatus: () => undefined,
      },
    );

    const messages = await source.init(-1, 100, 0);
    const incoming = messages.filter(
      (item) => item.data.type === 'msg' && !item.data.isSelf,
    );

    expect(incoming.every((item) => item.data.isGroupConversation)).toBe(true);
    expect(
      new Set(incoming.map((item) => item.data.name)).size,
    ).toBeGreaterThan(1);
  });

  it('serves search, moderation and forwarding entirely from memory', async () => {
    const adapter = new PlaygroundMessageThreadAdapter();
    adapter.itemCount.set(30);
    adapter.sourceLatency.set(0);
    adapter.createSource({ threadId: 1 } as ConversationItem, {
      onNewerAvailable: () => undefined,
      onMediaStatus: () => undefined,
    });

    const search = await firstValueFrom(
      adapter.searchMessages({
        threadId: 1,
        keyword: 'virtual scroll',
        take: 50,
      }),
    );
    const report = await firstValueFrom(
      adapter.reportMessage({ threadId: 1, seq: 1 }),
    );
    const blocked = await firstValueFrom(
      adapter.setBlocked({ threadId: 1, blocked: true }),
    );
    const forward = await firstValueFrom(
      adapter.sendForward({
        threadId: 2,
        sourceMessages: [{ threadId: 1, seq: 1 }],
        mode: 'DIRECT',
        clientMessageId: 'forward-1',
      }),
    );

    expect(search.code).toBe(0);
    expect(search.data?.length).toBeGreaterThan(0);
    expect(report.code).toBe(0);
    expect(blocked.code).toBe(0);
    expect(forward.code).toBe(0);
    expect(adapter.forwardTargets().length).toBe(3);
    expect(adapter.syncWithdrawalsAfterMutation()).toBe(false);
  });

  it('routes search and withdrawal to the requested conversation after switching threads', async () => {
    const adapter = new PlaygroundMessageThreadAdapter();
    adapter.sourceLatency.set(0);
    adapter.itemCount.set(30);
    const first = adapter.createSource({ threadId: 1 } as ConversationItem, {
      onNewerAvailable: () => undefined,
      onMediaStatus: () => undefined,
    }) as MockItemSource;
    adapter.itemCount.set(1);
    const second = adapter.createSource({ threadId: 2 } as ConversationItem, {
      onNewerAvailable: () => undefined,
      onMediaStatus: () => undefined,
    }) as MockItemSource;

    const search = await firstValueFrom(
      adapter.searchMessages({
        threadId: 1,
        keyword: 'virtual scroll',
        take: 50,
      }),
    );
    expect(search.data?.length).toBeGreaterThan(0);
    expect(second.search('virtual scroll', 50)).toEqual([]);

    await firstValueFrom(adapter.withdrawMessage({ threadId: 1, seq: 1 }));
    expect((await first.init(-1, 50, 0)).some((item) => item.id === 1)).toBe(
      false,
    );
    expect((await second.init(-1, 50, 0)).map((item) => item.id)).toEqual([1]);
  });

  it('keeps withdrawal successful when send errors are enabled', async () => {
    const adapter = new PlaygroundMessageThreadAdapter();
    adapter.itemCount.set(2);
    adapter.sourceLatency.set(0);
    const source = adapter.createSource({ threadId: 1 } as ConversationItem, {
      onNewerAvailable: () => undefined,
      onMediaStatus: () => undefined,
    }) as MockItemSource;
    adapter.sendError.set(true);

    const result = await firstValueFrom(
      adapter.withdrawMessage({ threadId: 1, seq: 1 }),
    );
    expect(result.code).toBe(0);
    expect((await source.init(-1, 50, 0)).map((item) => item.id)).toEqual([
      2,
    ]);
  });

  it('confirms a delayed link in its original conversation, not the newly opened one', async () => {
    const adapter = new PlaygroundMessageThreadAdapter();
    adapter.itemCount.set(0);
    adapter.sourceLatency.set(0);
    adapter.confirmDelay.set(10);
    const first = adapter.createSource({ threadId: 1 } as ConversationItem, {
      onNewerAvailable: () => undefined,
      onMediaStatus: () => undefined,
    }) as MockItemSource;
    first.addPending({
      id: -1,
      clientMessageId: 'link-1',
      data: {
        type: 'msg',
        msgId: -1,
        creator: JSON.stringify([0, 'mock.local', 'user-1']),
        isSelf: true,
        name: 'Me',
        text: 'Link for first thread',
        time: '12:00',
        contentType: 'LINK',
        images: null,
        file: null,
        createdAtMs: Date.now(),
      },
    });
    const sending = adapter.sendLink({
      threadId: 1,
      generationId: 'generation-1',
      clientMessageId: 'link-1',
    });
    const second = adapter.createSource({ threadId: 2 } as ConversationItem, {
      onNewerAvailable: () => undefined,
      onMediaStatus: () => undefined,
    }) as MockItemSource;

    expect((await sending).code).toBe(0);
    expect((await first.init(-1, 50, 0)).map((item) => item.id)).toEqual([1]);
    expect(await second.init(-1, 50, 0)).toEqual([]);
  });

  it('completes mock uploads without an HTTP transport', async () => {
    const adapter = new PlaygroundMessageThreadAdapter();
    const file = new File(['image'], 'sample.png', { type: 'image/png' });
    let loaded = 0;

    const result = await firstValueFrom(
      adapter.uploadPart<{
        url: string;
      }>(
        file,
        {
          clientMessageId: 'media-1',
          partId: 'part-1',
          position: 0,
          intent: 'IMAGE',
        },
        (value) => (loaded = value),
      ),
    );

    expect(result.code).toBe(0);
    expect(result.data?.url).toContain('blob:');
    expect(loaded).toBe(file.size);
    URL.revokeObjectURL(result.data!.url);
  });
});
