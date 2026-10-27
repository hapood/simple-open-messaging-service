import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createGroupConversation } from './model';
import { threadStructure } from './thread-feed.test-helper';
import { WebdbStorage } from './webdb-storage';

function page(scannedThrough: string, hasMore: boolean) {
  return {
    code: 0,
    data: {
      account: 'room',
      mode: 'full',
      items: [],
      scannedThrough,
      groupMetaFeedEndId: '3',
      hasMore,
    },
  };
}

describe('database worker Group Meta completion', () => {
  let receive: (event: MessageEvent) => void;
  const post = vi.fn();
  const fetch = vi.fn();
  let apply: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    vi.stubGlobal('postMessage', post);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal(
      'addEventListener',
      vi.fn((type, listener) => {
        if (type === 'message') receive = listener;
      }),
    );
    await import('./state-feed-db.worker');
  });

  beforeEach(() => {
    post.mockClear();
    fetch.mockReset();
    vi.spyOn(WebdbStorage.prototype, 'openForUser').mockResolvedValue(null);
    vi.spyOn(WebdbStorage.prototype, 'close').mockResolvedValue(undefined);
    vi.spyOn(WebdbStorage.prototype, 'getThreads').mockImplementation(
      async () => [
        createGroupConversation({
          threadId: 12,
          account: 'room',
          publisherNamespaceId: 7,
          profileRev: 1,
        }),
      ],
    );
    vi.spyOn(WebdbStorage.prototype, 'getThreadStates').mockResolvedValue([
      {
        ...threadStructure(12, {
          type: 'GROUP',
          publisherNamespaceId: 7,
          profileAccount: 'room',
          profileRev: 1,
        }),
        threadId: 12,
        localReadSeq: 0,
        threadFeedId: 1,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        alias: null,
        profileRev: 1,
        groupMetaFeedEndId: '3',
        joinRequestEndFeedId: 0,
        joinRequestReadFeedId: -1,
        groupInviteEndFeedId: 0,
        announcementReadFeedId: 0,
        lastReadSeq: 0,
        unreadCount: 0,
        lastMentionSeq: null,
      },
    ]);
    vi.spyOn(
      WebdbStorage.prototype,
      'beginGroupMetaRecovery',
    ).mockResolvedValue(undefined);
    apply = vi
      .spyOn(WebdbStorage.prototype, 'applyGroupMetaPage')
      .mockImplementation(async ({ page }) => ({
        threadId: 12,
        memberCount: 0,
        groupMetaFeedId: page.scannedThrough,
        announcementFeedId: null,
        announcementText: null,
        announcementCreatedAt: null,
        announcementOriginCreatedAt: null,
        groupMetaRecoveryThrough: page.hasMore ? '3' : null,
      }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function drain(id: number) {
    receive({
      data: {
        id,
        type: 'drain-thread-misc',
        userId: '42',
        threadId: 12,
      },
    } as MessageEvent);
  }

  it('posts fact completion before the drain reply without requesting member profiles', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => page('3', false) });
    drain(1);
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith({ id: 1, ok: true }),
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toContain('/user/group-meta?');
    expect(post.mock.calls.map(([event]) => event.type ?? 'reply')).toEqual([
      'group-meta-committed',
      'reply',
    ]);
    expect(post.mock.calls[0][0]).toMatchObject({
      userId: 42,
      threadIds: [12],
      patches: [{ groupMetaFeedId: '3' }],
    });
  });

  it('posts partial committed facts when a later page fails', async () => {
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => page('1', true) })
      .mockRejectedValueOnce(new Error('offline'));
    drain(2);
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith({ id: 2, ok: true }),
    );
    expect(post.mock.calls[0][0]).toMatchObject({
      type: 'group-meta-committed',
      userId: 42,
      threadIds: [12],
      patches: [{ groupMetaFeedId: '1', groupMetaRecoveryThrough: '3' }],
    });
    expect(apply).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
