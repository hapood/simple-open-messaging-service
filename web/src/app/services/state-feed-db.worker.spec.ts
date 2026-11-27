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
import { WebdbStorage } from './webdb-storage';
import { PreferenceStorage } from './preference-storage';

function page(scannedThrough: string, hasMore: boolean) {
  return {
    code: 0,
    data: {
      account: 'room',
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
  let pendingMeta: number[];

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
    pendingMeta = [];
    const thread = createGroupConversation({
      threadId: 12,
      account: 'room',
      publisherNamespaceId: 7,
      profileRev: 1,
    });
    vi.spyOn(PreferenceStorage.prototype, 'get').mockResolvedValue(undefined);
    vi.spyOn(WebdbStorage.prototype, 'openForUser').mockResolvedValue(null);
    vi.spyOn(WebdbStorage.prototype, 'close').mockResolvedValue(undefined);
    vi.spyOn(WebdbStorage.prototype, 'getThreads').mockImplementation(
      async () => [structuredClone(thread)],
    );
    vi.spyOn(WebdbStorage.prototype, 'getThreadStates').mockResolvedValue([]);
    vi.spyOn(
      WebdbStorage.prototype,
      'getThreadResourceHeads',
    ).mockResolvedValue([
      {
        threadId: 12,
        tombstoneEndSeq: 0,
        groupMetaFeedEndId: '3',
      },
    ]);
    vi.spyOn(
      WebdbStorage.prototype,
      'getPendingThreadResourceWork',
    ).mockImplementation(async () => ({
      tombThreadIds: [],
      metaThreadIds: pendingMeta,
    }));
    vi.spyOn(
      WebdbStorage.prototype,
      'beginGroupMetaRecovery',
    ).mockImplementation(async (_id, through) => {
      thread.meta.groupMetaFeedId = '0';
      thread.meta.recoveryThrough = through;
    });
    vi.spyOn(WebdbStorage.prototype, 'readAccountState').mockResolvedValue({
      selfProfile: null,
      selfIdentity: null,
      composerDrafts: [],
      threadFeedCursor: 0,
      stateFeedId: null,
      stateFeedTarget: 0,
      stateFeedFullThrough: null,
      profileNamespaceChangeEndId: null,
      intentRequestEndId: null,
      intentRequestReadId: null,
      intentRequestOptimisticReadId: null,
    });
    vi.spyOn(WebdbStorage.prototype, 'withThreadFeedLock').mockImplementation(
      async (run) => run(),
    );
    apply = vi
      .spyOn(WebdbStorage.prototype, 'applyGroupMetaPage')
      .mockImplementation(async ({ page }) => {
        thread.meta.groupMetaFeedId = page.scannedThrough;
        thread.meta.recoveryThrough = page.hasMore ? '3' : null;
        return {
          threadId: 12,
          memberCount: 0,
          groupMetaFeedId: page.scannedThrough,
          announcementFeedId: null,
          announcementText: null,
          announcementCreatedAt: null,
          announcementOriginCreatedAt: null,
          groupMetaRecoveryThrough: thread.meta.recoveryThrough,
        };
      });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function bind(id: number) {
    const port = {
      onmessage: null as ((event: { data: { target: number } }) => void) | null,
      start: vi.fn(),
      close: vi.fn(),
    };
    receive({
      data: { id, type: 'bind-thread-feed', userId: '42', port },
    } as unknown as MessageEvent);
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith({ id, ok: true }));
    return port;
  }

  it('posts explicit notification completion for an empty HELLO feed wake', async () => {
    const port = await bind(100);
    port.onmessage!({ data: { target: 0 } });
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith({
        type: 'notification-batch',
        userId: 42,
        entries: [],
        syncComplete: true,
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('schedules pending resource heads and publishes committed facts without member profile requests', async () => {
    pendingMeta = [12];
    fetch.mockResolvedValue({ ok: true, json: async () => page('3', false) });
    await bind(1);
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'group-meta-committed',
          userId: 42,
          threadIds: [12],
          patches: [expect.objectContaining({ groupMetaFeedId: '3' })],
        }),
      ),
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toContain('/user/group-meta?');
    expect(apply).toHaveBeenCalledOnce();
  });

  it('publishes each committed page before scheduling the next one', async () => {
    pendingMeta = [12];
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => page('1', true) })
      .mockImplementationOnce(async () => {
        expect(post).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'group-meta-committed',
            patches: [
              expect.objectContaining({
                groupMetaFeedId: '1',
                groupMetaRecoveryThrough: '3',
              }),
            ],
          }),
        );
        return { ok: true, json: async () => page('3', false) };
      });
    await bind(2);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
