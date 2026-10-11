/// <reference lib="webworker" />
import { API_PREFIX } from '../app/services/constants';
import { SOMS_NOTIF_MSG } from '../app/services/sw-notif-protocol';
import { WebdbStorage } from '../app/services/webdb-storage';
import { PreferenceStorage } from '../app/services/preference-storage';
import { syncPushThreads } from '../app/services/push-thread-sync';
import {
  advanceNotificationSince,
  readNotificationSince,
} from '../app/services/browser-notification-checkpoint';
import type { BrowserNotificationBatch } from '../app/services/notification-descriptor.model';
import en from '../app/i18n/en.json';
import zh from '../app/i18n/zh-CN.json';
import { activePageClientId } from '../app/services/active-page';

export function installPushWorker(scope: ServiceWorkerGlobalScope): void {
  const preferences = new PreferenceStorage();

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
          const since = await readNotificationSince();
          const pages = await scope.clients.matchAll({
            type: 'window',
            includeUncontrolled: true,
          });
          const { known, threadId: activeChat } = await visibleChat(pages);
          let end = since;
          for (const entry of data.entries) {
            if (data.userId !== (await accountId()) || postingSessionId !== await sessionId()) return;
            if (
              !Number.isInteger(entry.feedId) ||
              entry.feedId <= since ||
              !Number.isInteger(entry.descriptor?.data?.threadId) ||
              entry.descriptor.data.threadId! <= 0 ||
              entry.descriptor.tag !==
                `soms-thread-${entry.descriptor.data.threadId}` ||
              !Number.isInteger(entry.descriptor.count) ||
              entry.descriptor.count < 0
            )
              continue;
            if (entry.descriptor.count <= 0)
              await closeCard(entry.descriptor.tag);
            else if (known && entry.descriptor.data.threadId !== activeChat) {
              await scope.registration.showNotification(
                entry.descriptor.title,
                {
                  body: entry.descriptor.body,
                  tag: entry.descriptor.tag,
                  data: { ...entry.descriptor.data, sessionId: postingSessionId },
                  icon: entry.descriptor.icon ?? undefined,
                  lang: entry.descriptor.lang,
                  silent: entry.descriptor.silent,
                  renotify: entry.descriptor.renotify,
                } as NotificationOptions & { renotify: boolean },
              );
              if (data.userId !== (await accountId()) || postingSessionId !== await sessionId()) {
                await closeCard(entry.descriptor.tag);
                return;
              }
            }
            end = Math.max(end, entry.feedId);
          }
          if (data.userId === (await accountId()))
            await advanceNotificationSince(end);
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
    const value = await preferences.get<number>('device', 'soms.lastUserId');
    return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
  }

  // Registration recovery already durably records the HELLO session in the shared device store.
  async function sessionId(): Promise<number | null> {
    const saved = await preferences.get<{ sessionId: number; phase: string }>(
      'device', `push-registration:${API_PREFIX}`,
    );
    const id = saved?.sessionId;
    return saved?.phase === 'prepared' && Number.isInteger(id) && Number(id) > 0 && Number(id) <= 2147483647 ? Number(id) : null;
  }

  async function closeCard(tag: string): Promise<void> {
    for (const notification of await scope.registration.getNotifications({
      tag,
    }))
      notification.close();
  }

  scope.addEventListener('push', (event) => {
    event.waitUntil(
      (async () => {
        let payload: {
          type?: string;
          threadFeedEndId?: unknown;
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
          const response = await fetch(
            API_PREFIX + '/devices/push-probes/' + payload.probeId + '/ack',
            {
              method: 'POST',
              credentials: 'same-origin',
              signal: AbortSignal.timeout(10000),
            },
          );
          // A logout or account/session switch must not display an old session's probe.
          if (!response.ok || (await response.json())?.code !== 0) return;
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
        const rawTarget = payload?.threadFeedEndId;
        if (
          typeof rawTarget !== 'number' &&
          !(typeof rawTarget === 'string' && /^\d+$/.test(rawTarget))
        )
          return;
        const target = Number(rawTarget);
        if (
          payload?.type !== 'NEW_MESSAGE' ||
          !Number.isInteger(target) ||
          target < 0 ||
          target > 2147483647
        )
          return;
        await scope.navigator.locks.request(
          'soms-notification-projection',
          async () => {
            const userId = await accountId();
            const postingSessionId = await sessionId();
            if (userId === null || postingSessionId === null) return;
            const storage = new WebdbStorage();
            try {
              await storage.openExistingForUser(String(userId));
              const current = async () =>
                (await accountId()) === userId && (await sessionId()) === postingSessionId && storage.ready();
              if (!(await current())) return;
              const language =
                (await preferences.get<string>('global', 'language')) ??
                scope.navigator.language;
              const locale = language?.startsWith('zh') ? zh : en;
              const result = await syncPushThreads(
                storage,
                userId,
                target,
                async (body) => {
                  if (!(await current()))
                    throw new Error('notification account expired');
                  const response = await fetch(API_PREFIX + '/thread-feed', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(20000),
                  });
                  if (!response.ok)
                    throw new Error(`thread feed HTTP ${response.status}`);
                  if (!(await current()))
                    throw new Error('notification account expired');
                  return response.json();
                },
                preferences,
                {
                  lang: language,
                  privateBody: locale.settings.notifNewMessage,
                  retracted: '[' + locale.chat.messageRetracted + ']',
                  removed: '[' + locale.chat.messageRemovedByAdmin + ']',
                },
              );
              if (!(await current())) return;
              const pages = await scope.clients.matchAll({
                type: 'window',
                includeUncontrolled: true,
              });
              // Query the page at render time; a timeout suppresses visible-page alerts.
              const { known, threadId: activeChat } = await visibleChat(pages);
              for (const descriptor of result.notifications) {
                if (!(await current())) return;
                if (descriptor.count <= 0) await closeCard(descriptor.tag);
                else if (known && descriptor.data.threadId !== activeChat) {
                  const options: NotificationOptions & { renotify: boolean } = {
                    body: descriptor.body,
                    tag: descriptor.tag,
                    data: { ...descriptor.data, sessionId: postingSessionId },
                    icon: descriptor.icon ?? undefined,
                    lang: descriptor.lang,
                    silent: descriptor.silent,
                    renotify: descriptor.renotify,
                  };
                  await scope.registration.showNotification(
                    descriptor.title,
                    options,
                  );
                  if (!(await current())) {
                    await closeCard(descriptor.tag);
                    return;
                  }
                }
              }
              if (result.consumed)
                await advanceNotificationSince(result.cursor);
              for (const page of pages)
                page.postMessage({
                  type: SOMS_NOTIF_MSG.COMMITTED,
                  userId,
                  cursor: result.cursor,
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

  scope.addEventListener('notificationclick', (event) => {
    const threadId = event.notification.data?.threadId;
    const tapSessionId = event.notification.data?.sessionId;
    event.notification.close();
    event.waitUntil(
      (async () => {
        if (!Number.isInteger(threadId) || threadId <= 0 || threadId > 2147483647) return;
        if (!Number.isInteger(tapSessionId) || tapSessionId <= 0 || tapSessionId > 2147483647 || tapSessionId !== await sessionId()) return;
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
        if (tapSessionId !== await sessionId()) return;
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
            type: SOMS_NOTIF_MSG.OPEN, threadId,
            sessionId: tapSessionId,
          });
          await page.focus();
          return;
        }
        await scope.clients.openWindow('/chat/' + threadId + '?notificationSessionId=' + tapSessionId);
      })(),
    );
  });
}

if (
  typeof ServiceWorkerGlobalScope !== 'undefined' &&
  self instanceof ServiceWorkerGlobalScope
)
  installPushWorker(self);
