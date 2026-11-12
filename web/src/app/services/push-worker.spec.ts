import { installPushWorker } from '../../push/push-worker';
import { WebdbStorage } from './webdb-storage';
import { SessionLifecycleService } from './session-lifecycle.service';
import { PreferenceStorage } from './preference-storage';
import {
  projectNotificationReconstruction,
  syncPushThreads,
} from './push-thread-sync';
import { SOMS_NOTIF_MSG } from './sw-notif-protocol';
import { ACTIVE_PAGE_LOCK } from './active-page';
import { SessionStore, SESSION_STORE_KEY } from './session/session-store';
import { createSessionCacheDescriptor } from './session/session-identity';
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
  let workerScope: ServiceWorkerGlobalScope;
  let visible: boolean;
  let windowFocused: boolean;

  beforeEach(async () => {
    await resetNotificationSince();
    storage = new WebdbStorage(() => null, new SessionLifecycleService());
    await preferences.remove('device', SESSION_STORE_KEY);
    const cache = createSessionCacheDescriptor();
    const sessionStore = new SessionStore(preferences);
    await sessionStore.prepare(cache);
    await sessionStore.activate(cache.id);
    await sessionStore.bindIdentity(cache.id, {
      userId,
      serverSessionId: sessionId,
    });
    storage.bindSessionCache(cache);
    await storage.openForUser(String(userId));
    await preferences.set('device', 'soms.lastUserId', userId);
    await preferences.set('device', 'push-registration:/api/v1', {
      sessionId,
      phase: 'prepared',
    });
    handlers = new Map();
    show = vi.fn().mockResolvedValue(undefined);
    focus = vi.fn().mockResolvedValue(undefined);
    openWindow = vi.fn().mockResolvedValue(undefined);
    post = vi.fn();
    visible = false;
    windowFocused = true;
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
                    sender: {
                      account: 'peer',
                      profileNamespaceId: 1,
                      profileRev: 1,
                    },
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
    installPushWorker(
      (workerScope = {
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
              focused: windowFocused,
              postMessage: post,
              focus,
            },
          ],
          openWindow,
        },
        addEventListener: (type: string, handler: (event: unknown) => void) =>
          handlers.set(type, handler),
      } as unknown as ServiceWorkerGlobalScope),
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await storage.closeAndDelete(String(userId));
    await preferences.remove('device', 'soms.lastUserId');
    await preferences.remove('device', SESSION_STORE_KEY);
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

  it('drains request-only wakes via GET and independently advances the state checkpoint', async () => {
    await storage.applyStateFeedPage(
      [
        {
          feedId: 1,
          body: {
            requestEndId: '90071992547409930',
            requestReadId: '90071992547409930',
          },
        },
      ],
      1,
    );
    fetchSpy.mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe(
          '/api/v1/user/state-feed?mode=delta&after=1&through=2&take=100',
        );
        expect(init?.method ?? 'GET').toBe('GET');
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              mode: 'delta',
              items: [
                {
                  feedId: 2,
                  body: {
                    requestEndId: '90071992547409931',
                    requestReadId: '90071992547409930',
                  },
                },
              ],
              scannedThrough: 2,
              stateFeedEndId: 2,
              hasMore: false,
            },
          }),
        );
      },
    );
    await dispatch('push', {
      data: { json: () => ({ type: 'REQUEST_ATTENTION', stateFeedEndId: 2 }) },
    });
    expect(show).toHaveBeenCalledWith(
      'New incoming requests',
      expect.objectContaining({
        data: expect.objectContaining({ target: { kind: 'friend-requests' } }),
        silent: false,
      }),
    );
    expect(await readNotificationSince('state')).toBe(2);
    expect(await readNotificationSince()).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not deliver historical personal requests from an unobserved baseline', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            mode: 'full',
            items: [
              { feedId: 1, body: { requestEndId: '99', requestReadId: '0' } },
            ],
            scannedThrough: 1,
            stateFeedEndId: 1,
            hasMore: false,
          },
        }),
      ),
    );
    await dispatch('push', {
      data: { json: () => ({ type: 'REQUEST_ATTENTION', stateFeedEndId: 1 }) },
    });
    expect(show).not.toHaveBeenCalled();
  });

  it('removes a personal card from the durable optimistic-read event', async () => {
    await storage.applyStateFeedPage(
      [{ feedId: 1, body: { requestEndId: '8', requestReadId: '0' } }],
      1,
    );
    const close = vi.fn();
    workerScope.registration.getNotifications = vi.fn(async () => [
      {
        tag: 'soms-card-personal',
        data: { target: { kind: 'friend-requests' } },
        close,
      } as unknown as Notification,
    ]);
    const batches: unknown[] = [];
    const subscription = storage.browserNotifications$.subscribe((batch) =>
      batches.push(batch),
    );
    await storage.advanceIntentRequestRead('8');
    expect(batches).toHaveLength(1);
    await dispatch('message', {
      data: { type: SOMS_NOTIF_MSG.PRESENT, ...(batches[0] as object) },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(show).not.toHaveBeenCalled();
    subscription.unsubscribe();
  });

  it('delivers group requests with the chat open and clears the card on a durable local read', async () => {
    const original = await (await fetchSpy('/fixture')).json();
    const state = {
      ...original.data.items[0],
      type: 'GROUP',
      role: 'ADMIN',
      messageEndSeq: 0,
      unreadCount: 0,
      previews: [],
      joinRequestEndFeedId: 1,
      joinRequestReadFeedId: 0,
    };
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...original,
          data: { ...original.data, items: [state] },
        }),
      ),
    );
    await dispatch('push', {
      data: { json: () => ({ type: 'REQUEST_ATTENTION', threadFeedEndId: 1 }) },
    });
    show.mockClear();
    visible = true;
    post.mockImplementation((message, ports) => {
      if (message.type === SOMS_NOTIF_MSG.ACTIVE_CHAT_REQUEST)
        ports[0].postMessage({ threadId: 7 });
    });
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            items: [{ ...state, threadFeedId: 2, joinRequestEndFeedId: 2 }],
            through: 2,
            scannedThrough: 2,
            threadFeedEndId: 2,
            hasMore: false,
          },
        }),
      ),
    );
    await dispatch('push', {
      data: { json: () => ({ type: 'REQUEST_ATTENTION', threadFeedEndId: 2 }) },
    });
    expect(show).toHaveBeenCalledWith(
      'peer@test',
      expect.objectContaining({
        data: expect.objectContaining({
          target: { kind: 'group-join-requests', threadId: 7 },
        }),
        silent: false,
      }),
    );
    const close = vi.fn();
    workerScope.registration.getNotifications = vi.fn(async () => [
      {
        tag: 'soms-card-group',
        data: { target: { kind: 'group-join-requests', threadId: 7 } },
        close,
      } as unknown as Notification,
    ]);
    const batches: unknown[] = [];
    const subscription = storage.browserNotifications$.subscribe((batch) =>
      batches.push(batch),
    );
    await storage.patchThread(7, { joinRequestReadFeedId: 2 });
    expect(batches).toHaveLength(1);
    await dispatch('message', {
      data: { type: SOMS_NOTIF_MSG.PRESENT, ...(batches[0] as object) },
    });
    expect(close).toHaveBeenCalledOnce();
    subscription.unsubscribe();
  });

  it('removes a deleted group request through its durable reconciliation event without recreating it', async () => {
    const close = vi.fn();
    workerScope.registration.getNotifications = vi.fn(async () => [
      {
        tag: 'soms-card-deleted',
        data: { target: { kind: 'group-join-requests', threadId: 7 } },
        close,
      } as unknown as Notification,
    ]);
    const batches: unknown[] = [];
    const subscription = storage.browserNotifications$.subscribe((batch) =>
      batches.push(batch),
    );
    await storage.deleteThread(7);
    expect(batches).toHaveLength(1);
    await dispatch('message', {
      data: { type: SOMS_NOTIF_MSG.PRESENT, ...(batches[0] as object) },
    });
    expect(close).toHaveBeenCalledOnce();
    await dispatch('message', {
      data: {
        type: SOMS_NOTIF_MSG.PRESENT,
        userId,
        entries: [],
        syncComplete: true,
      },
    });
    expect(show).not.toHaveBeenCalled();
    subscription.unsubscribe();
  });

  it('lets a completed state stream remove a card while thread reconstruction is pending', async () => {
    await storage.applyStateFeedPage(
      [{ feedId: 1, body: { requestEndId: '8', requestReadId: '0' } }],
      1,
    );
    const close = vi.fn();
    workerScope.registration.getNotifications = vi.fn(
      async () =>
        [
          {
            tag: 'soms-card-personal',
            data: { target: { kind: 'friend-requests' } },
            close,
          },
          {
            tag: 'soms-card-chat',
            data: { target: { kind: 'thread', threadId: 7 } },
            close: vi.fn(),
          },
        ] as unknown as Notification[],
    );
    await dispatch('message', {
      data: {
        type: SOMS_NOTIF_MSG.PRESENT,
        userId,
        stream: 'state',
        syncComplete: true,
        entries: [],
      },
    });
    expect(show).toHaveBeenCalledOnce();
    await storage.applyStateFeedPage(
      [{ feedId: 2, body: { requestEndId: '8', requestReadId: '8' } }],
      2,
    );
    await dispatch('message', {
      data: {
        type: SOMS_NOTIF_MSG.PRESENT,
        userId,
        stream: 'state',
        syncComplete: true,
        entries: [
          {
            feedId: 2,
            descriptor: {
              kind: 'friend-requests',
              title: 'Requests',
              body: 'Requests',
              count: 0,
              lang: 'en',
              icon: null,
              data: { target: { kind: 'friend-requests' } },
            },
          },
        ],
      },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledOnce();
  });

  it('routes request taps to warm targets and the cold request URL', async () => {
    const target = { kind: 'group-join-requests', threadId: 7 };
    await dispatch('notificationclick', {
      notification: { data: { target, sessionId }, close: vi.fn() },
    });
    expect(post).toHaveBeenCalledWith({
      type: SOMS_NOTIF_MSG.OPEN,
      target,
      sessionId,
    });
    workerScope.clients.matchAll = vi.fn().mockResolvedValue([]);
    await dispatch('notificationclick', {
      notification: {
        data: { target: { kind: 'friend-requests' }, sessionId },
        close: vi.fn(),
      },
    });
    expect(openWindow).toHaveBeenCalledWith(
      '/?notificationSessionId=72&notificationTarget=friend-requests',
    );
  });

  it('uses the login store rather than last-user and subscription identity copies', async () => {
    await preferences.set('device', 'soms.lastUserId', 123456);
    await preferences.remove('device', 'push-registration:/api/v1');
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: '1' }) },
    });
    expect(show).toHaveBeenCalledWith(
      'peer@test',
      expect.objectContaining({
        data: expect.objectContaining({
          target: { kind: 'thread', threadId: 7 },
          seq: 1,
          sessionId,
        }),
      }),
    );
  });

  it('ignores background push while revocation awaits a user decision', async () => {
    const sessionStore = new SessionStore(preferences);
    const saved = await sessionStore.read();
    await sessionStore.beginRevocation(saved!.session!.id);
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: '1' }) },
    });
    expect(show).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await sessionStore.read())?.identity).toEqual({
      userId,
      serverSessionId: sessionId,
    });
  });

  it('ignores push work after logout while leaving the old cache on disk', async () => {
    const sessionStore = new SessionStore(preferences);
    const saved = await sessionStore.read();
    const cache = saved!.session!;
    await sessionStore.end(cache.id);
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: '1' }) },
    });
    await dispatch('push', {
      data: {
        json: () => ({
          type: 'PUSH_HEALTH_PROBE',
          probeId: '12345678-1234-1234-1234-123456789abc',
        }),
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect((await indexedDB.databases()).map((item) => item.name)).toContain(
      cache.indexedDbName,
    );
  });

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
      expect.objectContaining({
        body: 'Hello',
        data: expect.objectContaining({
          target: { kind: 'thread', threadId: 7 },
          seq: 1,
          sessionId,
        }),
      }),
    );
    expect((await storage.readAccountState()).threadFeedCursor).toBe(1);
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
  it.each([
    [true, false],
    [false, true],
    [false, false],
  ])(
    'allows the open chat when visible=%s and focused=%s',
    async (isVisible, isFocused) => {
      visible = isVisible;
      windowFocused = isFocused;
      post.mockImplementation(
        (message: { type: string }, ports?: MessagePort[]) => {
          if (message.type === SOMS_NOTIF_MSG.ACTIVE_CHAT_REQUEST)
            ports?.[0].postMessage({ threadId: 7 });
        },
      );
      await dispatch('push', {
        data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: '1' }) },
      });
      expect(show).toHaveBeenCalledOnce();
      expect(
        post.mock.calls.some(
          ([message]) => message.type === SOMS_NOTIF_MSG.ACTIVE_CHAT_REQUEST,
        ),
      ).toBe(false);
    },
  );

  it('clears the open card in the worker after a presentation observation', async () => {
    visible = true;
    windowFocused = true;
    const close = vi.fn();
    (
      workerScope as unknown as {
        registration: { getNotifications: () => Promise<unknown[]> };
      }
    ).registration.getNotifications = vi.fn().mockResolvedValue([
      {
        tag: 'soms-card-current',
        data: { target: { kind: 'thread', threadId: 7 } },
        close,
      },
    ]);
    post.mockImplementation(
      (message: { type: string }, ports?: MessagePort[]) => {
        if (message.type === SOMS_NOTIF_MSG.ACTIVE_CHAT_REQUEST)
          ports?.[0].postMessage({ threadId: 7 });
      },
    );
    await dispatch('message', {
      data: { type: SOMS_NOTIF_MSG.PRESENTATION_CHANGED },
      ports: [],
    });
    expect(close).toHaveBeenCalledOnce();
    expect(show).not.toHaveBeenCalled();
  });

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
              data: { target: { kind: 'thread', threadId: 7 } },
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
              data: { target: { kind: 'thread', threadId: 7 } },
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
                data: { target: { kind: 'thread', threadId: 7 } },
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
    const getNotifications = vi.fn().mockResolvedValue([
      {
        tag: 'soms-card-existing',
        data: { target: { kind: 'thread', threadId: 7 } },
        close,
      },
    ]);
    const scope = {
      navigator: {
        language: 'en',
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
        syncComplete: true,
        entries: [
          {
            feedId: 1,
            descriptor: {
              tag: 'soms-thread-7',
              title: 'Peer',
              body: '',
              count: 0,
              data: { target: { kind: 'thread', threadId: 7 } },
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
              data: { target: { kind: 'thread', threadId: 7 } },
            },
          },
        ],
      },
    });
    expect(show).not.toHaveBeenCalled();
    expect(await readNotificationSince()).toBe(0);
  });
  function installSystemCards(threads: number[]) {
    const active = new Map<string, Notification>();
    const add = (threadId: number, suffix = String(threadId)) => {
      const tag = `soms-card-${suffix}`;
      const card = {
        tag,
        data: {
          target: { kind: 'thread', threadId },
          sessionId,
          hasAcceptedAlert: true,
        },
        body: 'Before fetch',
        close: () => {
          if (active.get(tag) === card) active.delete(tag);
        },
      } as Notification;
      active.set(tag, card);
      return card;
    };
    threads.forEach((thread) => add(thread));
    vi.spyOn(workerScope.registration, 'getNotifications').mockImplementation(
      async (options) =>
        [...active.values()].filter(
          (card) => !options?.tag || card.tag === options.tag,
        ),
    );
    show.mockImplementation(
      async (_title: string, options: NotificationOptions) => {
        const card = {
          tag: options.tag!,
          data: options.data,
          body: options.body,
          close: () => {
            if (active.get(card.tag) === card) active.delete(card.tag);
          },
        } as Notification;
        active.set(card.tag, card);
      },
    );
    return { active, add };
  }

  it('captures before HELLO, pauses only new offline work, and reconstructs after an empty successful online delta', async () => {
    const { active } = installSystemCards([7, 8]);
    const reply = vi.fn();
    workerScope.clients.get = vi.fn().mockResolvedValue({ id: 'active-page' });
    await dispatch('message', {
      data: { type: SOMS_NOTIF_MSG.RESTORE },
      source: { id: 'active-page' },
      ports: [{ postMessage: reply }],
    });
    expect(reply).toHaveBeenCalledWith({ ok: true });
    expect(workerScope.registration.getNotifications).toHaveBeenCalledOnce();
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 1 }) },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    // HELLO has now started the online database worker; incomplete synchronization
    // cannot retire candidates. Its complete merge may have no notification delta.
    await dispatch('message', {
      data: {
        type: SOMS_NOTIF_MSG.PRESENT,
        userId,
        entries: [],
        syncComplete: false,
      },
    });
    expect(active.size).toBe(2);
    await syncPushThreads(
      storage,
      userId,
      1,
      async () => (await fetch('/api/v1/thread-feed')).json(),
      preferences,
      {
        lang: 'en',
        privateBody: 'New message',
        retracted: '[Retracted]',
        removed: '[Removed]',
      },
    );
    await dispatch('message', {
      data: {
        type: SOMS_NOTIF_MSG.PRESENT,
        userId,
        entries: [],
        syncComplete: true,
      },
    });
    expect([...active.keys()]).toEqual(['soms-card-7']);
    expect(active.get('soms-card-7')?.body).toContain('Hello');
    expect(show).toHaveBeenCalledOnce();
    expect(show.mock.lastCall?.[1]).toMatchObject({
      tag: 'soms-card-7',
      silent: true,
    });
    expect(workerScope.registration.getNotifications).toHaveBeenCalledOnce();
    fetchSpy.mockClear();
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 1 }) },
    });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: SOMS_NOTIF_MSG.COMMITTED }),
    );
    expect(show).toHaveBeenCalledOnce();
  });

  it('starts a fresh recovery round when push wakes a restarted worker', async () => {
    const { active } = installSystemCards([7, 8]);
    workerScope.clients.get = vi.fn().mockResolvedValue({ id: 'active-page' });
    await dispatch('message', {
      data: { type: SOMS_NOTIF_MSG.RESTORE },
      source: { id: 'active-page' },
    });
    // Replace event handlers with a fresh Worker lifetime while keeping the same
    // registration, OS cards and live document. No second RESTORE is sent by the page.
    installPushWorker(workerScope);
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 1 }) },
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledOnce();
    expect(show.mock.lastCall?.[1]).toMatchObject({
      tag: 'soms-card-7',
      silent: true,
    });
    expect([...active.keys()]).toEqual(['soms-card-7']);
    expect(workerScope.registration.getNotifications).toHaveBeenCalledTimes(2);
  });

  it('starts fresh reconstruction on an empty online batch after worker restart', async () => {
    const { active } = installSystemCards([7, 8]);
    await dispatch('message', {
      data: { type: SOMS_NOTIF_MSG.RESTORE },
      source: { id: 'active-page' },
    });
    installPushWorker(workerScope);
    await syncPushThreads(
      storage,
      userId,
      1,
      async () => (await fetch('/api/v1/thread-feed')).json(),
      preferences,
      {
        lang: 'en',
        privateBody: 'New message',
        retracted: '[Retracted]',
        removed: '[Removed]',
      },
    );
    await dispatch('message', {
      data: {
        type: SOMS_NOTIF_MSG.PRESENT,
        userId,
        entries: [],
        syncComplete: true,
      },
    });
    expect([...active.keys()]).toEqual(['soms-card-7']);
    expect(active.get('soms-card-7')?.body).toContain('Hello');
    expect(workerScope.registration.getNotifications).toHaveBeenCalledTimes(2);
    await dispatch('message', {
      data: {
        type: SOMS_NOTIF_MSG.PRESENT,
        userId,
        entries: [],
        syncComplete: true,
      },
    });
    expect(workerScope.registration.getNotifications).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenCalledOnce();
  });

  it('keeps the fresh online recovery round pending after partial sync without recapturing', async () => {
    const { active } = installSystemCards([7, 8]);
    await dispatch('message', {
      data: { type: SOMS_NOTIF_MSG.RESTORE },
      source: { id: 'active-page' },
    });
    installPushWorker(workerScope);
    workerScope.clients.get = vi.fn().mockResolvedValue({ id: 'active-page' });
    await dispatch('message', {
      data: {
        type: SOMS_NOTIF_MSG.PRESENT,
        userId,
        entries: [],
        syncComplete: false,
      },
      source: { id: 'active-page' },
    });
    expect(active.size).toBe(2);
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 1 }) },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await syncPushThreads(
      storage,
      userId,
      1,
      async () => (await fetch('/api/v1/thread-feed')).json(),
      preferences,
      {
        lang: 'en',
        privateBody: 'New message',
        retracted: '[Retracted]',
        removed: '[Removed]',
      },
    );
    await dispatch('message', {
      data: {
        type: SOMS_NOTIF_MSG.PRESENT,
        userId,
        entries: [],
        syncComplete: true,
      },
      source: { id: 'active-page' },
    });
    expect([...active.keys()]).toEqual(['soms-card-7']);
    expect(show.mock.lastCall?.[1]).toMatchObject({
      tag: 'soms-card-7',
      silent: true,
    });
    expect(workerScope.registration.getNotifications).toHaveBeenCalledTimes(2);
  });

  it('excludes cards closed while the worker was stopped from the new recovery round', async () => {
    const { active } = installSystemCards([7, 8]);
    await dispatch('message', {
      data: { type: SOMS_NOTIF_MSG.RESTORE },
      source: { id: 'active-page' },
    });
    active.get('soms-card-7')!.close();
    installPushWorker(workerScope);
    await syncPushThreads(
      storage,
      userId,
      1,
      async () => (await fetch('/api/v1/thread-feed')).json(),
      preferences,
      {
        lang: 'en',
        privateBody: 'New message',
        retracted: '[Retracted]',
        removed: '[Removed]',
      },
    );
    await dispatch('message', {
      data: {
        type: SOMS_NOTIF_MSG.PRESENT,
        userId,
        entries: [],
        syncComplete: true,
      },
    });
    expect(active.size).toBe(0);
    expect(show).not.toHaveBeenCalled();
    expect(workerScope.registration.getNotifications).toHaveBeenCalledTimes(2);
  });

  it('keeps page candidates across a rejected reconstruction and honors close callbacks on retry', async () => {
    const { active } = installSystemCards([7]);
    workerScope.clients.get = vi.fn().mockResolvedValue({ id: 'active-page' });
    await dispatch('message', {
      data: { type: SOMS_NOTIF_MSG.RESTORE },
      source: { id: 'active-page' },
    });
    await syncPushThreads(
      storage,
      userId,
      1,
      async () => (await fetch('/api/v1/thread-feed')).json(),
      preferences,
      {
        lang: 'en',
        privateBody: 'New message',
        retracted: '[Retracted]',
        removed: '[Removed]',
      },
    );
    show.mockRejectedValueOnce(new Error('OS unavailable'));
    const completed = {
      type: SOMS_NOTIF_MSG.PRESENT,
      userId,
      entries: [],
      syncComplete: true,
    };
    await expect(dispatch('message', { data: completed })).rejects.toThrow(
      'OS unavailable',
    );
    fetchSpy.mockClear();
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 2 }) },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const dismissed = active.get('soms-card-7')!;
    dismissed.close();
    await dispatch('notificationclose', { notification: dismissed });
    show.mockClear();
    await dispatch('message', { data: completed });
    expect(show).not.toHaveBeenCalled();
    expect(active.size).toBe(0);
    expect(workerScope.registration.getNotifications).toHaveBeenCalledOnce();
  });

  it('resets the page recovery pause on explicit session cleanup', async () => {
    installSystemCards([]);
    workerScope.clients.get = vi.fn().mockResolvedValue({ id: 'active-page' });
    await dispatch('message', {
      data: { type: SOMS_NOTIF_MSG.RESTORE },
      source: { id: 'active-page' },
    });
    await dispatch('message', { data: { type: SOMS_NOTIF_MSG.RESET } });
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 1 }) },
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledOnce();
  });

  it('allows offline recovery when the restoring document has closed', async () => {
    const { active } = installSystemCards([7]);
    workerScope.clients.get = vi.fn().mockResolvedValue(undefined);
    await dispatch('message', {
      data: { type: SOMS_NOTIF_MSG.RESTORE },
      source: { id: 'closed-page' },
    });
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 1 }) },
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(active.get('soms-card-7')?.body).toContain('Hello');
    expect(workerScope.registration.getNotifications).toHaveBeenCalledOnce();
  });

  it('does not wait for an already admitted push when entering page restoration', async () => {
    installSystemCards([7]);
    const response = await fetchSpy.getMockImplementation()!(
      '/api/v1/thread-feed',
    );
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fetchSpy.mockImplementationOnce(async () => {
      await pending;
      return response;
    });
    const pushing = dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 1 }) },
    });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    const reply = vi.fn();
    await dispatch('message', {
      data: { type: SOMS_NOTIF_MSG.RESTORE },
      source: { id: 'active-page' },
      ports: [{ postMessage: reply }],
    });
    expect(reply).toHaveBeenCalledWith({ ok: true });
    finish();
    await pushing;
  });

  it('reconstructs the OS intersection through the real push entry and removes expired candidates', async () => {
    const { active } = installSystemCards([7, 8]);
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 1 }) },
    });
    expect([...active.keys()]).toEqual(['soms-card-7']);
    expect(active.get('soms-card-7')?.body).toContain('Hello');
    expect(show).toHaveBeenCalledOnce();
    expect(show.mock.lastCall?.[1]).toMatchObject({
      tag: 'soms-card-7',
      silent: true,
      renotify: false,
    });
    show.mockClear();
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 1 }) },
    });
    expect(show).not.toHaveBeenCalled();
  });

  it('deduplicates before fetching and reconstructs only the retained instance', async () => {
    const { active, add } = installSystemCards([7]);
    add(7, 'duplicate');
    const response = await fetchSpy.getMockImplementation()!(
      '/api/v1/thread-feed',
    );
    fetchSpy.mockImplementationOnce(async () => {
      expect([...active.keys()]).toEqual(['soms-card-7']);
      return response;
    });
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 1 }) },
    });
    expect(show).toHaveBeenCalledOnce();
    expect(show.mock.lastCall?.[1]).toMatchObject({
      tag: 'soms-card-7',
      silent: true,
    });
    expect([...active.keys()]).toEqual(['soms-card-7']);
  });

  it('does not recreate a candidate clicked during fetch through the ordinary delta path', async () => {
    const { active } = installSystemCards([7]);
    const response = await fetchSpy.getMockImplementation()!(
      '/api/v1/thread-feed',
    );
    fetchSpy.mockImplementationOnce(async () => {
      await dispatch('notificationclick', {
        notification: active.get('soms-card-7')!,
      });
      return response;
    });
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 1 }) },
    });
    expect(active.size).toBe(0);
    expect(show).not.toHaveBeenCalled();
  });

  it('preserves candidates on a failed fetch and rebuilds only after a later successful merge', async () => {
    const { active } = installSystemCards([7, 8]);
    fetchSpy.mockRejectedValueOnce(new Error('offline'));
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 1 }) },
    });
    expect([...active.keys()]).toEqual(['soms-card-7', 'soms-card-8']);
    expect(show).not.toHaveBeenCalled();
    const dismissed = active.get('soms-card-7')!;
    dismissed.close();
    await dispatch('notificationclose', { notification: dismissed });
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 1 }) },
    });
    expect(active.size).toBe(0);
    expect(show).not.toHaveBeenCalled();
  });

  it('retries failed reconstruction from complete merged state without recapturing new instances', async () => {
    const { active, add } = installSystemCards([7]);
    show.mockRejectedValueOnce(new Error('OS unavailable'));
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 1 }) },
    });
    expect(active.get('soms-card-7')?.body).toBe('Before fetch');
    const later = add(8, 'later');
    show.mockClear();
    fetchSpy.mockClear();
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: 1 }) },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledOnce();
    expect(active.get('soms-card-7')?.body).toContain('Hello');
    expect(active.get(later.tag)).toBe(later);
  });

  it('explicit reconstruction includes unchanged merged states while an empty delta stays empty', async () => {
    const copy = {
      lang: 'en',
      privateBody: 'New message',
      retracted: '[Retracted]',
      removed: '[Removed]',
    };
    const first = await syncPushThreads(
      storage,
      userId,
      1,
      async () => (await fetch('/api/v1/thread-feed')).json(),
      preferences,
      copy,
    );
    expect(first.notifications).toHaveLength(1);
    const noRequest = vi.fn(async () => {
      throw new Error('already synchronized');
    });
    const delta = await syncPushThreads(
      storage,
      userId,
      1,
      noRequest,
      preferences,
      copy,
    );
    expect(delta.notifications).toEqual([]);
    expect(noRequest).not.toHaveBeenCalled();
    const merged = await storage.getThreadStates();
    const rebuilt = await projectNotificationReconstruction(
      storage,
      userId,
      preferences,
      copy,
      merged,
    );
    expect(rebuilt).toEqual(first.notifications);
    expect(
      await projectNotificationReconstruction(
        storage,
        userId,
        preferences,
        copy,
        [],
      ),
    ).toEqual([]);
    await preferences.set('device', 'notificationEnabled', false);
    try {
      expect(
        await projectNotificationReconstruction(
          storage,
          userId,
          preferences,
          copy,
          merged,
        ),
      ).toEqual([]);
    } finally {
      await preferences.remove('device', 'notificationEnabled');
    }
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
    await storage.mergeThreadStates([], 1);
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: '1' }) },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect(await readNotificationSince()).toBe(0);
  });
  it('carries the required notification session to an existing page', async () => {
    await dispatch('notificationclick', {
      notification: {
        data: {
          target: { kind: 'thread', threadId: 7 },
          latestSeq: 8,
          sessionId,
        },
        close: vi.fn(),
      },
    });
    expect(post).toHaveBeenCalledWith({
      type: SOMS_NOTIF_MSG.OPEN,
      target: { kind: 'thread', threadId: 7 },
      latestSeq: 8,
      sessionId,
    });
  });

  it('does not navigate a notification belonging to a previous session on the same account', async () => {
    await dispatch('notificationclick', {
      notification: {
        data: {
          target: { kind: 'thread', threadId: 7 },
          latestSeq: 8,
          sessionId: sessionId + 1,
        },
        close: vi.fn(),
      },
    });
    expect(post).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('rejects legacy receipts and receipts without an active login', async () => {
    for (const data of [
      { threadId: 7 },
      { threadId: 7, userId },
      { threadId: 7, sessionId: 0 },
      ...[undefined, null, -1, '8', 0.5, 2147483648].map((latestSeq) => ({
        target: { kind: 'thread', threadId: 7 },
        latestSeq,
        sessionId,
      })),
    ]) {
      await dispatch('notificationclick', {
        notification: { data, close: vi.fn() },
      });
    }
    const sessionStore = new SessionStore(preferences);
    const saved = await sessionStore.read();
    await sessionStore.end(saved!.session!.id);
    await dispatch('notificationclick', {
      notification: {
        data: {
          target: { kind: 'thread', threadId: 7 },
          latestSeq: 8,
          sessionId,
        },
        close: vi.fn(),
      },
    });
    expect(post).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('routes a body tap without an action request', async () => {
    const close = vi.fn();
    await dispatch('notificationclick', {
      notification: {
        data: {
          target: { kind: 'thread', threadId: 7 },
          latestSeq: 8,
          sessionId,
        },
        close,
      },
    });
    expect(post).toHaveBeenCalledWith({
      type: SOMS_NOTIF_MSG.OPEN,
      target: { kind: 'thread', threadId: 7 },
      latestSeq: 8,
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
      notification: {
        data: {
          target: { kind: 'thread', threadId: 7 },
          latestSeq: 8,
          sessionId,
        },
        close: vi.fn(),
      },
    });

    expect(post).toHaveBeenCalledWith({
      type: SOMS_NOTIF_MSG.OPEN,
      target: { kind: 'thread', threadId: 7 },
      latestSeq: 8,
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
      notification: {
        data: {
          target: { kind: 'thread', threadId: 7 },
          latestSeq: 8,
          sessionId,
        },
        close: vi.fn(),
      },
    });

    expect(adminPost).not.toHaveBeenCalled();
    expect(adminFocus).not.toHaveBeenCalled();
    expect(chatPost).toHaveBeenCalledWith({
      type: SOMS_NOTIF_MSG.OPEN,
      target: { kind: 'thread', threadId: 7 },
      latestSeq: 8,
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
      notification: {
        data: {
          target: { kind: 'thread', threadId: 7 },
          latestSeq: 8,
          sessionId,
        },
        close: vi.fn(),
      },
    });

    expect(openWindow).toHaveBeenCalledWith(
      '/chat/7?notificationSessionId=' + sessionId + '&latestSeq=8',
    );
    expect(adminPost).not.toHaveBeenCalled();
    expect(adminFocus).not.toHaveBeenCalled();
  });

  it('can present a server count without a self profile when no optimistic correction is needed', async () => {
    await dispatch('push', {
      data: { json: () => ({ type: 'NEW_MESSAGE', threadFeedEndId: '1' }) },
    });
    expect(show).toHaveBeenCalled();
    expect((await storage.readAccountState()).threadFeedCursor).toBe(1);
  });
});
