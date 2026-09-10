/// <reference lib="webworker" />
import { API_PREFIX } from '../app/services/constants';
import { SOMS_NOTIF_MSG } from '../app/services/sw-notif-protocol';
import { WebdbStorage } from '../app/services/webdb-storage';
import { PreferenceStorage } from '../app/services/preference-storage';
import { syncPushThreads } from '../app/services/push-thread-sync';
import { advanceNotificationSince } from '../app/services/browser-notification-checkpoint';
import en from '../app/i18n/en.json';
import zh from '../app/i18n/zh-CN.json';
import { activePageClientId } from '../app/services/active-page';

export function installPushWorker(scope: ServiceWorkerGlobalScope): void {
  const preferences = new PreferenceStorage();

  async function accountId(): Promise<number | null> {
    const value = await preferences.get<number>('device', 'soms.lastUserId');
    return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
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
        // Without cross-context locks, let ordinary page synchronization own the feed.
        if (!scope.navigator.locks) return;
        let payload: { type?: string; threadFeedEndId?: unknown };
        try {
          payload = event.data?.json();
        } catch {
          return;
        }
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
            if (userId === null) return;
            const storage = new WebdbStorage();
            try {
              await storage.openExistingForUser(String(userId));
              const current = async () =>
                (await accountId()) === userId && storage.ready();
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
                  const response = await fetch(
                    API_PREFIX + '/thread/feed-delta',
                    {
                      method: 'POST',
                      credentials: 'same-origin',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify(body),
                      signal: AbortSignal.timeout(20000),
                    },
                  );
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
              const activeId = await activePageClientId(scope.navigator.locks);
              const visible = pages.some(
                (page) =>
                  page.id === activeId &&
                  (page as WindowClient).visibilityState === 'visible' &&
                  (page as WindowClient).focused,
              );
              for (const descriptor of result.notifications) {
                if (!(await current())) return;
                if (descriptor.count <= 0) await closeCard(descriptor.tag);
                else if (!visible) {
                  const options: NotificationOptions & { renotify: boolean } = {
                    body: descriptor.body,
                    tag: descriptor.tag,
                    data: descriptor.data,
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
    event.notification.close();
    event.waitUntil(
      (async () => {
        if (!Number.isInteger(threadId) || threadId <= 0) return;
        const activeId = scope.navigator.locks
          ? await activePageClientId(scope.navigator.locks)
          : undefined;
        for (const page of await scope.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        })) {
          if (page.id !== activeId) continue;
          page.postMessage({ type: SOMS_NOTIF_MSG.OPEN, threadId });
          await (page as WindowClient).focus();
          return;
        }
        await scope.clients.openWindow('/chat/' + threadId);
      })(),
    );
  });
}

if (
  typeof ServiceWorkerGlobalScope !== 'undefined' &&
  self instanceof ServiceWorkerGlobalScope
)
  installPushWorker(self);
