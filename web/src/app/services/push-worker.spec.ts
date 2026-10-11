import 'fake-indexeddb/auto';
import { installPushWorker } from '../../push/push-worker';
import { WebdbStorage } from './webdb-storage';
import { SessionLifecycleService } from './session-lifecycle.service';
import { PreferenceStorage } from './preference-storage';
import { syncPushThreads } from './push-thread-sync';
import { SOMS_NOTIF_MSG } from './sw-notif-protocol';
import { ACTIVE_PAGE_LOCK } from './active-page';
import { threadStructure } from './thread-feed.test-helper';
import {
  readNotificationSince,
  resetNotificationSince,
} from './browser-notification-checkpoint';

describe('Push Service Worker entry', () => {
  const userId = 9407;
  const sessionId = 72;
  const preferences = new PreferenceStorage();
  let storage: WebdbStorage;
  let handlers: Map<string, (event: unknown) => void>;
  let show: ReturnType<typeof vi.fn>;
  let focus: ReturnType<typeof vi.fn>;
  let openWindow: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let post: ReturnType<typeof vi.fn>;
  let visible: boolean;

  beforeEach(async () => {
    await resetNotificationSince();
    storage = new WebdbStorage(() => null, new SessionLifecycleService());
    await storage.openForUser(String(userId));
    await storage.putMeta('selfProfile', { id: userId, account: 'me' });
    await preferences.set('device', 'soms.lastUserId', userId);
    await preferences.set('device', 'push-registration:/api/v1', { sessionId, phase: 'prepared' });
    handlers = new Map();
    show = vi.fn().mockResolvedValue(undefined);
    focus = vi.fn().mockResolvedValue(undefined);
    openWindow = vi.fn().mockResolvedValue(undefined);
    post = vi.fn();
    visible = false;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            items: [
              {
                ...threadStructure(7, {
                  publisherNamespaceId: 1,
                  profileAccount: 'peer',
                  profileRev: 1,
                }),
                threadFeedId: 1,
                messageEndSeq: 1,
                tombstoneEndSeq: 0,
                alias: 'peer@test',
                profileRev: 1,
                groupMetaFeedEndId: null,
                joinRequestEndFeedId: 0,
                joinRequestReadFeedId: -1,
                groupInviteEndFeedId: 0,
                lastReadSeq: 0,
                announcementReadFeedId: 0,
                unreadCount: 1,
                lastMentionSeq: null,
                previews: [
                  {
                    seq: 1,
                    createdAt: '2026-09-09T00:00:00Z',
                    sender: { account: 'peer', profileNamespaceId: 1, profileRev: 1 },
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
            url: 'https://chat.test/',
            visibilityState: visible ? 'visible' : 'hidden',
            focused: visible,
            postMessage: post,
            focus,
          },
        ],
        openWindow,
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

  it('acknowledges a real probe and displays a test notification without syncing messages', async () => {
    const probeId = '12345678-1234-1234-1234-123456789abc';
    await dispatch('push', {
      data: { json: () => ({ type: 'PUSH_HEALTH_PROBE', probeId }) },
    });
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
      '/api/v1/devices/push-probes/' + probeId + '/ack',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
    expect(show).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tag: 'soms-push-probe' }),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('does not display a previous session probe rejected by the server', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ code: 10007 }), { status: 200 }),
    );
    await dispatch('push', {
      data: {
        json: () => ({
          type: 'PUSH_HEALTH_PROBE',
          probeId: '12345678-1234-1234-1234-123456789abc',
        }),
      },
    });
    expect(show).not.toHaveBeenCalled();
  });

  it('ignores malformed probe IDs without requesting an arbitrary URL', async () => {
    await dispatch('push', {
      data: {
        json: () => ({ type: 'PUSH_HEALTH_PROBE', probeId: '../other' }),
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });
  it('consumes the unified feed, posts a notification and wakes the page after committing', async () => {
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: '1' }) },
    });
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/v1/thread-feed');
    expect(
      JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).previewCount,
    ).toBe(3);
    expect(show).toHaveBeenCalledWith(
      'peer@test',
      expect.objectContaining({ body: 'Hello', data: { threadId: 7, seq: 1, sessionId } }),
    );
    expect(await storage.getSyncState('threadFeedCursor')).toBe(1);
    expect(post).toHaveBeenCalledWith({
      type: SOMS_NOTIF_MSG.COMMITTED,
      userId,
      cursor: 1,
    });
    expect(await readNotificationSince()).toBe(1);
  });
  it.each([
    [7, false],
    [9, true],
  ])(
    'while focused only suppresses the open chat (%i)',
    async (threadId, shouldShow) => {
      visible = true;
      post.mockImplementation(
        (message: { type: string }, ports?: MessagePort[]) => {
          if (message.type === SOMS_NOTIF_MSG.ACTIVE_CHAT_REQUEST)
            ports?.[0].postMessage({ threadId });
        },
      );
      await dispatch('push', {
        data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: '1' }) },
      });
      expect(show).toHaveBeenCalledTimes(shouldShow ? 1 : 0);
    },
  );
  it('renders worker-projected messages in the service worker without a push wake', async () => {
    await dispatch('message', {
      data: {
        type: SOMS_NOTIF_MSG.PRESENT,
        userId,
        entries: [
          {
            feedId: 1,
            descriptor: {
              tag: 'soms-thread-7',
              title: 'Peer',
              body: 'Hello',
              count: 1,
              data: { threadId: 7 },
            },
          },
        ],
      },
    });
    expect(show).toHaveBeenCalledWith(
      'Peer',
      expect.objectContaining({ body: 'Hello' }),
    );
    expect(await readNotificationSince()).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    await dispatch('message', {
      data: {
        type: SOMS_NOTIF_MSG.PRESENT,
        userId,
        entries: [
          {
            feedId: 1,
            descriptor: {
              tag: 'soms-thread-7',
              title: 'Peer',
              body: 'Hello',
              count: 1,
              data: { threadId: 7 },
            },
          },
        ],
      },
    });
    expect(show).toHaveBeenCalledOnce();
  });
  it.each([
    [7, false],
    [9, true],
  ])(
    'worker presentation skips only the visible chat (%i)',
    async (threadId, shouldShow) => {
      visible = true;
      post.mockImplementation(
        (message: { type: string }, ports?: MessagePort[]) => {
          if (message.type === SOMS_NOTIF_MSG.ACTIVE_CHAT_REQUEST)
            ports?.[0].postMessage({ threadId });
        },
      );
      await dispatch('message', {
        data: {
          type: SOMS_NOTIF_MSG.PRESENT,
          userId,
          entries: [
            {
              feedId: 1,
              descriptor: {
                tag: 'soms-thread-7',
                title: 'Peer',
                body: 'Hello',
                count: 1,
                data: { threadId: 7 },
              },
            },
          ],
        },
      });
      expect(show).toHaveBeenCalledTimes(shouldShow ? 1 : 0);
      expect(await readNotificationSince()).toBe(1);
    },
  );
  it('closes only the affected card when the worker reports no unread messages', async () => {
    const close = vi.fn();
    const getNotifications = vi
      .fn()
      .mockResolvedValue([{ tag: 'soms-thread-7', close }]);
    const scope = {
      navigator: {
        locks: {
          request: async (_name: string, run: () => Promise<void>) => run(),
          query: async () => ({ held: [], pending: [] }),
        },
      },
      registration: { showNotification: show, getNotifications },
      clients: { matchAll: async () => [] },
      addEventListener: (type: string, handler: (event: unknown) => void) =>
        handlers.set(type, handler),
    } as unknown as ServiceWorkerGlobalScope;
    installPushWorker(scope);
    await dispatch('message', {
      data: {
        type: SOMS_NOTIF_MSG.PRESENT,
        userId,
        entries: [
          {
            feedId: 1,
            descriptor: {
              tag: 'soms-thread-7',
              title: 'Peer',
              body: '',
              count: 0,
              data: { threadId: 7 },
            },
          },
        ],
      },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(show).not.toHaveBeenCalled();
  });
  it('ignores a worker batch from a different account', async () => {
    await dispatch('message', {
      data: {
        type: SOMS_NOTIF_MSG.PRESENT,
        userId: userId + 1,
        entries: [
          {
            feedId: 1,
            descriptor: {
              tag: 'soms-thread-7',
              title: 'Peer',
              body: 'Hello',
              count: 1,
              data: { threadId: 7 },
            },
          },
        ],
      },
    });
    expect(show).not.toHaveBeenCalled();
    expect(await readNotificationSince()).toBe(0);
  });
  it('shows the page-worker result exactly once when it consumed the feed before push', async () => {
    const pageResult = await syncPushThreads(
      storage,
      userId,
      1,
      async () => await (await fetch('/api/v1/thread-feed')).json(),
      preferences,
      {
        lang: 'en',
        privateBody: 'New message',
        retracted: '[Retracted]',
        removed: '[Removed]',
      },
    );
    expect(pageResult.notifications).toHaveLength(1);
    fetchSpy.mockClear();
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: '1' }) },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    await dispatch('message', {
      data: {
        type: SOMS_NOTIF_MSG.PRESENT,
        userId,
        entries: [
          {
            feedId: pageResult.states[0].threadFeedId,
            descriptor: pageResult.notifications[0],
          },
        ],
      },
    });
    expect(show).toHaveBeenCalledOnce();
    expect(await readNotificationSince()).toBe(1);
  });
  it('does not suppress a page notification when the page already consumed the target', async () => {
    await storage.putSyncState('threadFeedCursor', 1);
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: '1' }) },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect(await readNotificationSince()).toBe(0);
  });
  it('carries the required notification session to an existing page', async () => {
    await dispatch('notificationclick', {
      notification: { data: { threadId: 7, sessionId }, close: vi.fn() },
    });
    expect(post).toHaveBeenCalledWith({ type: SOMS_NOTIF_MSG.OPEN, threadId: 7, sessionId });
  });

  it('does not navigate a notification belonging to a previous session on the same account', async () => {
    await dispatch('notificationclick', {
      notification: { data: { threadId: 7, sessionId: sessionId + 1 }, close: vi.fn() },
    });
    expect(post).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('rejects legacy thread/account receipts and absent registration metadata', async () => {
    for (const data of [{ threadId: 7 }, { threadId: 7, userId }, { threadId: 7, sessionId: 0 }]) {
      await dispatch('notificationclick', { notification: { data, close: vi.fn() } });
    }
    await preferences.remove('device', 'push-registration:/api/v1');
    await dispatch('notificationclick', { notification: { data: { threadId: 7, sessionId }, close: vi.fn() } });
    expect(post).not.toHaveBeenCalled(); expect(openWindow).not.toHaveBeenCalled();
  });

  it('routes a body tap without an action request', async () => {
    const close = vi.fn();
    await dispatch('notificationclick', {
      notification: { data: { threadId: 7, sessionId }, close },
    });
    expect(post).toHaveBeenCalledWith({
      type: SOMS_NOTIF_MSG.OPEN,
      threadId: 7,
      sessionId,
    });
    expect(focus).toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reuses an existing page when the active-page lock owner cannot be matched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const existingPage = {
      id: 'existing-page',
      url: 'https://chat.test/',
      visibilityState: 'hidden',
      focused: false,
      postMessage: post,
      focus,
    };
    const scope = {
      navigator: {
        language: 'en',
        locks: {
          query: async () => ({
            held: [{ name: ACTIVE_PAGE_LOCK, clientId: 'missing-page' }],
            pending: [],
          }),
        },
      },
      registration: {
        showNotification: show,
        getNotifications: async () => [],
      },
      clients: {
        matchAll: async () => [existingPage],
        openWindow,
      },
      addEventListener: (type: string, handler: (event: unknown) => void) =>
        handlers.set(type, handler),
    } as unknown as ServiceWorkerGlobalScope;
    handlers.clear();
    installPushWorker(scope);

    await dispatch('notificationclick', {
      notification: { data: { threadId: 7, sessionId }, close: vi.fn() },
    });

    expect(post).toHaveBeenCalledWith({
      type: SOMS_NOTIF_MSG.OPEN,
      threadId: 7,
      sessionId,
    });
    expect(focus).toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[push] active page client was not matched; reusing an existing page',
      {
        activeId: 'missing-page',
        clients: [
          {
            id: 'existing-page',
            focused: false,
            visibilityState: 'hidden',
          },
        ],
      },
    );
  });

  it('ignores the admin page when choosing an existing page', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adminPost = vi.fn();
    const adminFocus = vi.fn().mockResolvedValue(undefined);
    const chatPost = vi.fn();
    const chatFocus = vi.fn().mockResolvedValue(undefined);
    const scope = {
      navigator: { language: 'en' },
      registration: {
        showNotification: show,
        getNotifications: async () => [],
      },
      clients: {
        matchAll: async () => [
          {
            id: 'admin-page',
            url: 'https://chat.test/admin/',
            visibilityState: 'visible',
            focused: true,
            postMessage: adminPost,
            focus: adminFocus,
          },
          {
            id: 'chat-page',
            url: 'https://chat.test/',
            visibilityState: 'hidden',
            focused: false,
            postMessage: chatPost,
            focus: chatFocus,
          },
        ],
        openWindow,
      },
      addEventListener: (type: string, handler: (event: unknown) => void) =>
        handlers.set(type, handler),
    } as unknown as ServiceWorkerGlobalScope;
    handlers.clear();
    installPushWorker(scope);

    await dispatch('notificationclick', {
      notification: { data: { threadId: 7, sessionId }, close: vi.fn() },
    });

    expect(adminPost).not.toHaveBeenCalled();
    expect(adminFocus).not.toHaveBeenCalled();
    expect(chatPost).toHaveBeenCalledWith({
      type: SOMS_NOTIF_MSG.OPEN,
      threadId: 7,
      sessionId,
    });
    expect(chatFocus).toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('opens a user page when only the admin page exists', async () => {
    const adminPost = vi.fn();
    const adminFocus = vi.fn().mockResolvedValue(undefined);
    const scope = {
      navigator: { language: 'en' },
      registration: {
        showNotification: show,
        getNotifications: async () => [],
      },
      clients: {
        matchAll: async () => [
          {
            id: 'admin-page',
            url: 'https://chat.test/admin/',
            visibilityState: 'visible',
            focused: true,
            postMessage: adminPost,
            focus: adminFocus,
          },
        ],
        openWindow,
      },
      addEventListener: (type: string, handler: (event: unknown) => void) =>
        handlers.set(type, handler),
    } as unknown as ServiceWorkerGlobalScope;
    handlers.clear();
    installPushWorker(scope);

    await dispatch('notificationclick', {
      notification: { data: { threadId: 7, sessionId }, close: vi.fn() },
    });

    expect(openWindow).toHaveBeenCalledWith('/chat/7?notificationSessionId=' + sessionId);
    expect(adminPost).not.toHaveBeenCalled();
    expect(adminFocus).not.toHaveBeenCalled();
  });

  it('can present a server count without a self profile when no optimistic correction is needed', async () => {
    await storage.putMeta('selfProfile', null);
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: '1' }) },
    });
    expect(show).toHaveBeenCalled();
    expect(await storage.getSyncState('threadFeedCursor')).toBe(1);
  });
});
