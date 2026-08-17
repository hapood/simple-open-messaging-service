import { firstValueFrom } from 'rxjs';
import type { ConversationItem } from '../app/services/model';
import { PlaygroundMessageThreadAdapter } from './playground-message-thread.adapter';

describe('PlaygroundMessageThreadAdapter', () => {
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
        onProfile: () => undefined,
      },
    );

    const messages = await source.init(-1, 100, 0);
    const incoming = messages.filter(
      (item) => item.data.type === 'msg' && !item.data.isSelf,
    );

    expect(incoming.every((item) => item.data.isGroupConversation)).toBeTrue();
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
      onProfile: () => undefined,
    });

    const search = await firstValueFrom(
      adapter.searchMessages({
        threadId: 1,
        keyword: 'virtual scroll',
        take: 50,
      }),
    );
    const report = await firstValueFrom(
      adapter.reportMessages({ threadId: 1, seqs: [1] }),
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
    expect(forward.code).toBe(0);
    expect(adapter.forwardTargets().length).toBe(3);
    expect(adapter.syncWithdrawalsAfterMutation()).toBeFalse();
  });

  it('completes mock uploads without an HTTP transport', async () => {
    const adapter = new PlaygroundMessageThreadAdapter();
    const file = new File(['image'], 'sample.png', { type: 'image/png' });
    let loaded = 0;

    const result = await firstValueFrom(
      adapter.uploadPart<{ url: string }>(
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
