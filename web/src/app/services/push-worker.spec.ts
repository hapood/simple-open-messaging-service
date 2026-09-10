import 'fake-indexeddb/auto';
import { installPushWorker } from '../../push/push-worker';
import { WebdbStorage } from './webdb-storage';
import { PreferenceStorage } from './preference-storage';
import { SOMS_NOTIF_MSG } from './sw-notif-protocol';
import { ACTIVE_PAGE_LOCK } from './active-page';
import {
  readNotificationSince,
  resetNotificationSince,
} from './browser-notification-checkpoint';

describe('Push Service Worker entry', () => {
  const userId = 9407;
  const preferences = new PreferenceStorage();
  let storage: WebdbStorage;
  let handlers: Map<string, (event: unknown) => void>;
  let show: ReturnType<typeof vi.fn>;
  let open: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let post: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await resetNotificationSince();
    storage = new WebdbStorage();
    await storage.openForUser(String(userId));
    await storage.putMeta('selfProfile', { id: userId, account: 'me' });
    await preferences.set('device', 'soms.lastUserId', userId);
    handlers = new Map();
    show = vi.fn().mockResolvedValue(undefined);
    open = vi.fn().mockResolvedValue(undefined);
    post = vi.fn();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            items: [
              {
                threadId: 7,
                threadFeedId: 1,
                messageEndSeq: 1,
                tombstoneEndSeq: 0,
                lastReadSeq: 0,
                unreadCount: 1,
                lastMentionSeq: null,
                previews: [
                  {
                    seq: 1,
                    createdAt: '2026-09-09T00:00:00Z',
                    sender: { account: 'peer', domain: 'test' },
                    status: 'LIVE',
                    text: 'Hello',
                  },
                ],
              },
            ],
            through: 1,
            scannedThrough: 1,
            threadFeedEndId: 1,
            hasMore: false,
          },
        }),
      ),
    );
    installPushWorker({
      navigator: {
        language: 'en',
        locks: {
          request: async (_name: string, run: () => Promise<void>) => run(),
          query: async () => ({
            held: [{ name: ACTIVE_PAGE_LOCK, clientId: 'active-page' }],
            pending: [],
          }),
        },
      },
      registration: {
        showNotification: show,
        getNotifications: async () => [],
      },
      clients: {
        matchAll: async () => [
          {
            id: 'active-page',
            visibilityState: 'hidden',
            focused: false,
            postMessage: post,
            focus: open,
          },
        ],
        openWindow: open,
      },
      addEventListener: (type: string, handler: (event: unknown) => void) =>
        handlers.set(type, handler),
    } as unknown as ServiceWorkerGlobalScope);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await storage.closeAndDelete(String(userId));
    await preferences.remove('device', 'soms.lastUserId');
  });
  async function dispatch(type: string, payload: Record<string, unknown>) {
    let pending: Promise<unknown> | undefined;
    handlers.get(type)!({
      ...payload,
      waitUntil: (work: Promise<unknown>) => {
        pending = work;
      },
    });
    await pending;
  }
  it('consumes the unified feed, posts a notification and wakes the page after committing', async () => {
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: '1' }) },
    });
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/v1/thread/feed-delta');
    expect(
      JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).previewCount,
    ).toBe(5);
    expect(show).toHaveBeenCalledWith(
      'peer@test',
      expect.objectContaining({ body: 'Hello', data: { threadId: 7, seq: 1 } }),
    );
    expect(await storage.getMeta('threadFeedCursor')).toBe(1);
    expect(post).toHaveBeenCalledWith({
      type: SOMS_NOTIF_MSG.COMMITTED,
      userId,
      cursor: 1,
    });
    expect(await readNotificationSince()).toBe(1);
  });
  it('does not suppress a page notification when the page already consumed the target', async () => {
    await storage.putMeta('threadFeedCursor', 1);
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: '1' }) },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect(await readNotificationSince()).toBe(0);
  });
  it('routes a body tap without an action request', async () => {
    const close = vi.fn();
    await dispatch('notificationclick', {
      notification: { data: { threadId: 7 }, close },
    });
    expect(post).toHaveBeenCalledWith({
      type: SOMS_NOTIF_MSG.OPEN,
      threadId: 7,
    });
    expect(open).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('can present a server count without a self profile when no optimistic correction is needed', async () => {
    await storage.putMeta('selfProfile', null);
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: '1' }) },
    });
    expect(show).toHaveBeenCalled();
    expect(await storage.getMeta('threadFeedCursor')).toBe(1);
  });
});
