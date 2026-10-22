/** The push worker owns browser notification rendering and click routing. The page may only
 * dismiss cards when a chat becomes visible or the account session ends. */
const SW_SCOPE = '/push/';
const SOMS_TAG_PREFIX = 'soms-';

export async function clearBrowserMessageNotifications(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  for (const notification of (await reg?.getNotifications()) ?? []) {
    if (notification.tag.startsWith(SOMS_TAG_PREFIX)) notification.close();
  }
}

export class BrowserNotificationAdapter {
  private async withProjectionLock(run: () => Promise<void>): Promise<void> {
    try {
      if (navigator.locks)
        await navigator.locks.request('soms-notification-projection', run);
      else await run();
    } catch (error) {
      console.warn('[notification] browser cleanup failed', error);
    }
  }

  async clearThread(threadId: number): Promise<void> {
    await this.withProjectionLock(async () => {
      const reg = await navigator.serviceWorker?.getRegistration(SW_SCOPE);
      const tag = `soms-thread-${threadId}`;
      for (const notification of (await reg?.getNotifications({ tag })) ?? []) {
        if (notification.tag === tag) notification.close();
      }
    });
  }

  async clear(): Promise<void> {
    await this.withProjectionLock(clearBrowserMessageNotifications);
  }
}
