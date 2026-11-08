import { clearBrowserMessageNotifications } from './browser-notification.adapter';
import { isAndroidNative, isTauri, tauriInvoke } from './runtime';
import { SOMS_NOTIF_MSG } from './sw-notif-protocol';

/** Enter notification restoration before HELLO. The worker captures candidates and
 * disables new offline deliveries; already in-flight work is not drained or repaired.
 */
export async function withNotificationRestoration<T>(
  restore: () => Promise<T>,
): Promise<T> {
  const registration = await navigator.serviceWorker?.getRegistration('/push/');
  if (registration?.active) {
    const channel = new MessageChannel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Notification restoration timed out')), 20000);
        channel.port1.onmessage = ({ data }) => {
          clearTimeout(timer);
          if (data?.ok) resolve();
          else reject(new Error('Notification restoration failed'));
        };
        registration.active!.postMessage({ type: SOMS_NOTIF_MSG.RESTORE }, [channel.port2]);
      });
    } finally {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
    }
  }
  return restore();
}

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
