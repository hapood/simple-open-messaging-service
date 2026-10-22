import { clearBrowserMessageNotifications } from './browser-notification.adapter';
import { isAndroidNative, isTauri, tauriInvoke } from './runtime';

/** Real login/logout only. Cold-start session restoration must preserve a notification's pending tap. */
export async function clearSessionNotifications(): Promise<void> {
  if (isAndroidNative()) {
    window.SomsFcm!.clearMessageNotifications();
  } else if (isTauri()) {
    await tauriInvoke<void>('desktop_notifications_clear', {
      resetNavigation: true,
    });
  } else {
    const clear = () => clearBrowserMessageNotifications();
    if (navigator.locks)
      await navigator.locks.request('soms-notification-projection', clear);
    else await clear();
  }
}
