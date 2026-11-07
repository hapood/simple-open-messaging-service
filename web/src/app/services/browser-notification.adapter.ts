import { SOMS_NOTIF_MSG } from './sw-notif-protocol';

/** The push worker owns rendering and thread removal decisions. The page reports facts. */
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

  async presentationChanged(): Promise<void> {
    const reg = await navigator.serviceWorker?.getRegistration(SW_SCOPE);
    reg?.active?.postMessage({ type: SOMS_NOTIF_MSG.PRESENTATION_CHANGED });
  }

  async clear(): Promise<void> {
    await this.withProjectionLock(clearBrowserMessageNotifications);
  }
}
