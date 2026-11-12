/// <reference lib="webworker" />
import { parseNotificationOpening } from '../../../shared/notification-opening';
import { BrowserNotificationCards } from './notification-cards';
import { API_PREFIX } from '../app/services/constants';
import { SOMS_NOTIF_MSG } from '../app/services/sw-notif-protocol';
import { WebdbStorage } from '../app/services/webdb-storage';
import { PreferenceStorage } from '../app/services/preference-storage';
import {
  projectNotificationReconstruction,
  syncPushThreads,
} from '../app/services/push-thread-sync';
import {
  advanceNotificationSince,
  readNotificationSince,
} from '../app/services/browser-notification-checkpoint';
import type { BrowserNotificationBatch } from '../app/services/notification-descriptor.model';
import en from '../app/i18n/en.json';
import zh from '../app/i18n/zh-CN.json';
import { activePageClientId } from '../app/services/active-page';
import { SessionStore } from '../app/services/session/session-store';
import {
  isActiveMessage,
  notificationClickUrl,
  notificationKey,
} from '../app/services/notification-routing';
import { syncPushState } from '../app/services/push-state-sync';
import {
  friendRequestNotification,
  groupRequestNotification,
  requestNotificationSettings,
} from '../app/services/request-notification';

export function installPushWorker(scope: ServiceWorkerGlobalScope): void {
  const preferences = new PreferenceStorage();
  const cards = new BrowserNotificationCards(
    scope.registration,
    async () =>
      (await preferences.get<string>('device', 'notificationAlertPolicy')) ??
      undefined,
  );
  const sessionStore = new SessionStore(preferences);
  // Resource restoration belongs to this Worker lifetime and the existing cache owner.
  // Keep the original candidates on failure; recapturing could admit new instances.
  let reconstruction:
    | {
        cacheId: string;
        candidates: Map<string, string>;
        complete: boolean;
        threadComplete?: boolean;
        stateComplete?: boolean;
        pageClientId?: string;
      }
    | undefined;

  async function activeCache() {
    const saved = await sessionStore.read();
    return saved?.phase === 'active' ? saved.session : null;
  }

  async function visibleChat(pages: readonly Client[]): Promise<{
    known: boolean;
    threadId?: number;
  }> {
    const activeId = await activePageClientId(scope.navigator.locks);
    const activePage = pages.find(
      (page) =>
        page.id === activeId &&
        (page as WindowClient).visibilityState === 'visible' &&
        (page as WindowClient).focused,
    );
    if (!activePage) return { known: true };
    const channel = new MessageChannel();
    let known = false;
    let threadId: number | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const reply = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 500);
      channel.port1.onmessage = (answer) => {
        threadId = answer.data?.threadId;
        known = true;
        resolve();
      };
    });
    try {
      activePage.postMessage({ type: SOMS_NOTIF_MSG.ACTIVE_CHAT_REQUEST }, [
        channel.port2,
      ]);
      await reply;
    } catch {
      // A closing page cannot answer; conservatively suppress visible-page alerts.
    } finally {
      clearTimeout(timer!);
      channel.port1.close();
    }
    return { known, threadId };
  }

  scope.addEventListener('message', (event) => {
    const data = event.data as Partial<BrowserNotificationBatch> & {
      type?: string;
    };
    if (data?.type === SOMS_NOTIF_MSG.RESET) {
      reconstruction = undefined;
      cards.reset();
      return;
    }
    if (data?.type === SOMS_NOTIF_MSG.RESTORE) {
      event.waitUntil(
        (async () => {
          try {
            const cache = await activeCache();
            if (cache) {
              // Publish offline admission before enumeration. Do not wait for in-flight push work.
              const restoring = (reconstruction = {
                cacheId: cache.id,
                candidates: new Map<string, string>(),
                complete: false,
                pageClientId: (event.source as Client | null)?.id,
              });
              restoring.candidates = await cards.reconstructionCandidates();
            }
            event.ports?.[0]?.postMessage({ ok: true });
          } catch {
            event.ports?.[0]?.postMessage({ ok: false });
          }
        })(),
      );
      return;
    }
    if (
      data?.type === SOMS_NOTIF_MSG.PRESENTATION_CHANGED &&
      scope.navigator.locks
    ) {
      event.waitUntil(
        scope.navigator.locks.request(
          'soms-notification-projection',
          async () => {
            try {
              const pages = await scope.clients.matchAll({
                type: 'window',
                includeUncontrolled: true,
              });
              const { known, threadId } = await visibleChat(pages);
              if (known && Number.isInteger(threadId) && threadId! > 0)
                await cards.remove(threadId!);
              event.ports?.[0]?.postMessage({ ok: true });
            } catch {
              event.ports?.[0]?.postMessage({ ok: false });
            }
          },
        ),
      );
      return;
    }
    if (data?.type !== SOMS_NOTIF_MSG.PRESENT || !scope.navigator.locks) return;
    event.waitUntil(
      scope.navigator.locks.request(
        'soms-notification-projection',
        async () => {
          if (
            data.userId !== (await accountId()) ||
            !Array.isArray(data.entries)
          )
            return;
          const postingSessionId = await sessionId();
          if (postingSessionId === null) return;
          const stream = data.stream === 'state' ? 'state' : 'thread';
          const since = await readNotificationSince(stream);
          const pages = await scope.clients.matchAll({
            type: 'window',
            includeUncontrolled: true,
          });
          const { known, threadId: activeChat } = await visibleChat(pages);
          const cache = await activeCache();
          if (
            (data.requestReadChanged ||
              data.groupRequestReadChanged !== undefined) &&
            cache
          ) {
            const storage = new WebdbStorage();
            storage.bindSessionCache(cache);
            try {
              await storage.openExistingForUser(String(data.userId));
              const settings = await requestNotificationSettings(
                preferences,
                scope.navigator.language,
              );
              if (data.groupRequestReadChanged !== undefined) {
                const state = (await storage.getThreadStates()).find(
                  (item) => item.threadId === data.groupRequestReadChanged,
                );
                if (
                  (await activeCache())?.id === cache.id &&
                  (!state ||
                    groupRequestNotification(state, '', settings).count === 0)
                )
                  await cards.remove(
                    `group-join-requests:${data.groupRequestReadChanged}`,
                  );
              } else {
                const descriptor = friendRequestNotification(
                  await storage.readAccountState(),
                  settings,
                );
                if (
                  (await activeCache())?.id === cache.id &&
                  descriptor.count === 0
                )
                  await cards.remove('friend-requests');
              }
            } finally {
              await storage.close();
            }
            return;
          }
          // A new Worker lifetime starts a new recovery round from current OS cards.
          // This also applies when the first wake is an empty online sync result.
          if (cache && reconstruction?.cacheId !== cache.id) {
            reconstruction = {
              cacheId: cache.id,
              candidates: await cards.reconstructionCandidates(),
              complete: false,
              pageClientId: (event.source as Client | null)?.id,
            };
          }
          const restoring =
            reconstruction?.cacheId === cache?.id && !reconstruction?.complete
              ? reconstruction
              : undefined;
          const candidateThreads = new Set(
            [...(restoring?.candidates.values() ?? [])].filter((key) =>
              key === 'friend-requests'
                ? !restoring?.stateComplete
                : !restoring?.threadComplete,
            ),
          );
          if (
            restoring &&
            !(stream === 'state'
              ? restoring.stateComplete
              : restoring.threadComplete) &&
            data.syncComplete === true &&
            known &&
            cache
          ) {
            const storage = new WebdbStorage();
            storage.bindSessionCache(cache);
            try {
              await storage.openExistingForUser(String(data.userId));
              const language =
                (await preferences.get<string>('global', 'language')) ??
                scope.navigator.language;
              const locale = language.startsWith('zh') ? zh : en;
              const projection = await projectNotificationReconstruction(
                storage,
                data.userId!,
                preferences,
                {
                  lang: language,
                  privateBody: locale.settings.notifNewMessage,
                  retracted: '[' + locale.chat.messageRetracted + ']',
                  removed: '[' + locale.chat.messageRemovedByAdmin + ']',
                },
                await storage.getThreadStates(),
              );
              if ((await activeCache())?.id !== cache.id) return;
              const candidates = new Map(
                [...restoring.candidates].filter(
                  ([, key]) =>
                    (key === 'friend-requests') === (stream === 'state'),
                ),
              );
              const descriptors =
                stream === 'state'
                  ? [
                      friendRequestNotification(
                        await storage.readAccountState(),
                        await requestNotificationSettings(
                          preferences,
                          language,
                        ),
                      ),
                    ]
                  : projection;
              await cards.reconstruct(
                candidates,
                descriptors.map((descriptor) =>
                  isActiveMessage(descriptor.data, activeChat)
                    ? { ...descriptor, count: 0 }
                    : descriptor,
                ),
                postingSessionId,
              );
              if (stream === 'state') restoring.stateComplete = true;
              else restoring.threadComplete = true;
              restoring.complete =
                ((restoring.stateComplete ||
                  ![...restoring.candidates.values()].includes(
                    'friend-requests',
                  )) &&
                  (restoring.threadComplete ||
                    ![...restoring.candidates.values()].some(
                      (key) => key !== 'friend-requests',
                    ))) ||
                false;
            } finally {
              await storage.close();
            }
          }
          let end = since;
          for (const entry of data.entries) {
            if (
              candidateThreads.has(notificationKey(entry.descriptor?.data)!)
            ) {
              if (Number.isInteger(entry.feedId))
                end = Math.max(end, entry.feedId);
              continue;
            }
            if (
              data.userId !== (await accountId()) ||
              postingSessionId !== (await sessionId())
            )
              return;
            if (
              !Number.isInteger(entry.feedId) ||
              entry.feedId <= since ||
              !notificationKey(entry.descriptor?.data) ||
              !Number.isInteger(entry.descriptor.count) ||
              entry.descriptor.count < 0
            )
              continue;
            if (
              entry.descriptor.count <= 0 ||
              (known && isActiveMessage(entry.descriptor.data, activeChat))
            )
              await cards.remove(notificationKey(entry.descriptor.data)!);
            else if (known) {
              const id = await cards.show(entry.descriptor, postingSessionId);
              if (
                data.userId !== (await accountId()) ||
                postingSessionId !== (await sessionId())
              ) {
                if (id) await cards.removeInstance(id);
                return;
              }
            }
            end = Math.max(end, entry.feedId);
          }
          if (data.userId === (await accountId()))
            await advanceNotificationSince(end, stream);
        },
      ),
    );
  });

  scope.addEventListener('pushsubscriptionchange', (event) => {
    (event as ExtendableEvent).waitUntil(
      (async () => {
        for (const client of await scope.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        }))
          client.postMessage({ type: 'soms-push-subscription-changed' });
        // With no open page, the next HELLO registers the browser's current subscription.
      })(),
    );
  });

  async function accountId(): Promise<number | null> {
    const saved = await sessionStore.read();
    return saved?.phase === 'active' ? (saved.identity?.userId ?? null) : null;
  }

  // Subscription recovery is not an identity authority. Background work uses
  // the same durable login record as the online runtime.
  async function sessionId(): Promise<number | null> {
    const saved = await sessionStore.read();
    return saved?.phase === 'active'
      ? (saved.identity?.serverSessionId ?? null)
      : null;
  }

  scope.addEventListener('push', (event) => {
    event.waitUntil(
      (async () => {
        let payload: {
          type?: string;
          threadFeedEndId?: unknown;
          stateFeedEndId?: unknown;
          probeId?: unknown;
        };
        try {
          payload = event.data?.json();
        } catch {
          return;
        }
        if (payload?.type === 'PUSH_HEALTH_PROBE') {
          if (
            typeof payload.probeId !== 'string' ||
            !/^[0-9a-f-]{36}$/i.test(payload.probeId)
          )
            return;
          const cache = await activeCache();
          if (!cache) return;
          const response = await fetch(
            API_PREFIX + '/devices/push-probes/' + payload.probeId + '/ack',
            {
              method: 'POST',
              credentials: 'same-origin',
              signal: AbortSignal.timeout(10000),
            },
          );
          // A logout or account/session switch must not display an old session's probe.
          if (
            !response.ok ||
            (await response.json())?.code !== 0 ||
            (await activeCache())?.id !== cache.id
          )
            return;
          const language =
            (await preferences.get<string>('global', 'language')) ??
            scope.navigator.language;
          const locale = language?.startsWith('zh') ? zh : en;
          await scope.registration.showNotification(
            locale.settings.pushProbeTitle,
            {
              body: locale.settings.pushProbeNotification,
              tag: 'soms-push-probe',
            },
          );
          return;
        }
        // Without cross-context locks, let ordinary page synchronization own the feed.
        if (!scope.navigator.locks) return;
        const coordinate = (raw: unknown): number | undefined => {
          if (
            typeof raw !== 'number' &&
            !(typeof raw === 'string' && /^\d+$/.test(raw))
          )
            return undefined;
          const value = Number(raw);
          return Number.isInteger(value) && value >= 0 && value <= 2147483647
            ? value
            : undefined;
        };
        const target = coordinate(payload?.threadFeedEndId);
        const stateTarget = coordinate(payload?.stateFeedEndId);
        if (
          !['NEW_MESSAGE', 'REQUEST_ATTENTION'].includes(payload?.type ?? '') ||
          (target === undefined && stateTarget === undefined)
        )
          return;
        // Admission only: a push already past this point is allowed to finish.
        if (
          reconstruction?.pageClientId &&
          !reconstruction.complete &&
          (await scope.clients.get(reconstruction.pageClientId))
        )
          return;
        await scope.navigator.locks.request(
          'soms-notification-projection',
          async () => {
            const userId = await accountId();
            const postingSessionId = await sessionId();
            if (userId === null || postingSessionId === null) return;
            const cache = await activeCache();
            if (!cache) return;
            if (reconstruction?.cacheId !== cache.id) {
              reconstruction = {
                cacheId: cache.id,
                candidates: await cards.reconstructionCandidates(),
                complete: false,
              };
            }
            const restoring = reconstruction.complete
              ? undefined
              : reconstruction;
            const storage = new WebdbStorage();
            storage.bindSessionCache(cache);
            try {
              await storage.openExistingForUser(String(userId));
              const current = async () =>
                (await activeCache())?.id === cache.id &&
                (await accountId()) === userId &&
                (await sessionId()) === postingSessionId &&
                storage.ready();
              if (!(await current())) return;
              const language =
                (await preferences.get<string>('global', 'language')) ??
                scope.navigator.language;
              const locale = language?.startsWith('zh') ? zh : en;
              const copy = {
                lang: language,
                privateBody: locale.settings.notifNewMessage,
                retracted: '[' + locale.chat.messageRetracted + ']',
                removed: '[' + locale.chat.messageRemovedByAdmin + ']',
              };
              const stateResult =
                stateTarget === undefined
                  ? undefined
                  : await syncPushState(
                      storage,
                      stateTarget,
                      async (body) => {
                        if (!(await current()))
                          throw new Error('notification account expired');
                        const params = new URLSearchParams(
                          Object.entries(body).map(([key, value]) => [
                            key,
                            String(value),
                          ]),
                        );
                        const response = await fetch(
                          API_PREFIX + '/user/state-feed?' + params,
                          {
                            credentials: 'same-origin',
                            signal: AbortSignal.timeout(20000),
                          },
                        );
                        if (!response.ok)
                          throw new Error(`state feed HTTP ${response.status}`);
                        if (!(await current()))
                          throw new Error('notification account expired');
                        return response.json();
                      },
                      preferences,
                      language,
                    );
              const result =
                target === undefined
                  ? {
                      states: [],
                      notifications: [],
                      consumed: false,
                      cursor:
                        (await storage.readAccountState()).threadFeedCursor ??
                        0,
                      error: undefined,
                    }
                  : await syncPushThreads(
                      storage,
                      userId,
                      target,
                      async (body) => {
                        if (!(await current()))
                          throw new Error('notification account expired');
                        const response = await fetch(
                          API_PREFIX + '/thread-feed',
                          {
                            method: 'POST',
                            credentials: 'same-origin',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify(body),
                            signal: AbortSignal.timeout(20000),
                          },
                        );
                        if (!response.ok)
                          throw new Error(
                            `thread feed HTTP ${response.status}`,
                          );
                        if (!(await current()))
                          throw new Error('notification account expired');
                        return response.json();
                      },
                      preferences,
                      copy,
                    );
              if (!(await current())) return;
              const pages = await scope.clients.matchAll({
                type: 'window',
                includeUncontrolled: true,
              });
              // Query the page at render time; a timeout suppresses visible-page alerts.
              const { known, threadId: activeChat } = await visibleChat(pages);
              const candidateThreads = new Set(
                [...(restoring?.candidates.values() ?? [])].filter((key) =>
                  key === 'friend-requests'
                    ? !restoring?.stateComplete
                    : !restoring?.threadComplete,
                ),
              );
              if (
                restoring &&
                !restoring.threadComplete &&
                !result.error &&
                known &&
                target !== undefined
              ) {
                const mergedStates = await storage.getThreadStates();
                const projection = await projectNotificationReconstruction(
                  storage,
                  userId,
                  preferences,
                  copy,
                  mergedStates,
                );
                if (!(await current())) return;
                await cards.reconstruct(
                  new Map(
                    [...restoring.candidates].filter(
                      ([, key]) => key !== 'friend-requests',
                    ),
                  ),
                  projection.map((descriptor) =>
                    isActiveMessage(descriptor.data, activeChat)
                      ? { ...descriptor, count: 0 }
                      : descriptor,
                  ),
                  postingSessionId,
                );
                if (!(await current())) return;
                restoring.threadComplete = true;
              }
              if (
                restoring &&
                !restoring.stateComplete &&
                stateResult &&
                !stateResult.error &&
                known
              ) {
                const descriptor = friendRequestNotification(
                  await storage.readAccountState(),
                  await requestNotificationSettings(preferences, language),
                );
                if (!(await current())) return;
                await cards.reconstruct(
                  new Map(
                    [...restoring.candidates].filter(
                      ([, key]) => key === 'friend-requests',
                    ),
                  ),
                  [descriptor],
                  postingSessionId,
                );
                restoring.stateComplete = true;
              }
              if (restoring)
                restoring.complete =
                  !!(
                    restoring.stateComplete ||
                    ![...restoring.candidates.values()].includes(
                      'friend-requests',
                    )
                  ) &&
                  !!(
                    restoring.threadComplete ||
                    ![...restoring.candidates.values()].some(
                      (key) => key !== 'friend-requests',
                    )
                  );
              for (const descriptor of [
                ...result.notifications,
                ...(stateResult?.notifications ?? []),
              ]) {
                // Candidate updates belong exclusively to intersection reconstruction.
                // In particular, a candidate clicked during fetch cannot re-enter here.
                if (candidateThreads.has(notificationKey(descriptor.data)!))
                  continue;
                if (!(await current())) return;
                if (
                  descriptor.count <= 0 ||
                  (known && isActiveMessage(descriptor.data, activeChat))
                )
                  await cards.remove(notificationKey(descriptor.data)!);
                else if (known) {
                  const id = await cards.show(descriptor, postingSessionId);
                  if (!(await current())) {
                    if (id) await cards.removeInstance(id);
                    return;
                  }
                }
              }
              if (result.consumed)
                await advanceNotificationSince(result.cursor);
              if (stateResult)
                await advanceNotificationSince(stateResult.cursor, 'state');
              for (const page of pages)
                page.postMessage({
                  type: SOMS_NOTIF_MSG.COMMITTED,
                  userId,
                  cursor: result.cursor,
                  ...(stateResult ? { stateCommitted: true } : {}),
                });
              if (result.error)
                console.warn('[push] partial thread sync', result.error);
            } finally {
              await storage.close();
            }
          },
        );
      })().catch((error) =>
        console.warn('[push] sync failed; waiting for the next wake', error),
      ),
    );
  });

  scope.addEventListener('notificationclose', (event) => {
    cards.dismissed(event.notification.tag);
  });

  scope.addEventListener('notificationclick', (event) => {
    cards.dismissed(event.notification.tag);
    const opening = parseNotificationOpening(event.notification.data);
    const tapSessionId = event.notification.data?.sessionId;
    event.notification.close();
    event.waitUntil(
      (async () => {
        if (!opening) return;
        if (
          !Number.isInteger(tapSessionId) ||
          tapSessionId <= 0 ||
          tapSessionId > 2147483647 ||
          tapSessionId !== (await sessionId())
        )
          return;
        const activeId = scope.navigator.locks
          ? await activePageClientId(scope.navigator.locks)
          : undefined;
        const pages = await scope.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        const windows = pages as WindowClient[];
        const appWindows = windows.filter((candidate) => {
          const pathname = new URL(candidate.url).pathname;
          return pathname !== '/admin' && !pathname.startsWith('/admin/');
        });
        const activePage = appWindows.find(
          (candidate) => candidate.id === activeId,
        );
        const page =
          activePage ??
          appWindows.find((candidate) => candidate.focused) ??
          appWindows.find(
            (candidate) => candidate.visibilityState === 'visible',
          ) ??
          appWindows[0];
        if (tapSessionId !== (await sessionId())) return;
        if (page) {
          if (!activePage)
            console.warn(
              '[push] active page client was not matched; reusing an existing page',
              {
                activeId,
                clients: appWindows.map((candidate) => ({
                  id: candidate.id,
                  focused: candidate.focused,
                  visibilityState: candidate.visibilityState,
                })),
              },
            );
          page.postMessage({
            type: SOMS_NOTIF_MSG.OPEN,
            ...opening,
            sessionId: tapSessionId,
          });
          await page.focus();
          return;
        }
        await scope.clients.openWindow(
          notificationClickUrl(opening, tapSessionId),
        );
      })(),
    );
  });
}

if (
  typeof ServiceWorkerGlobalScope !== 'undefined' &&
  self instanceof ServiceWorkerGlobalScope
)
  installPushWorker(self);
