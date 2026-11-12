import { SessionSupersededError } from './session/session-identity';
import { clearBrowserMessageNotifications } from './browser-notification.adapter';
import { isAndroidNative, isTauri, tauriInvoke } from './runtime';
import { getPushWorkerRegistration } from './push-worker-registration';
import { SOMS_NOTIF_MSG } from './sw-notif-protocol';

/** Notification recovery is mandatory when a notification worker exists.
 * Retry against the current active worker, but never retry the local restore callback.
 */
export async function withNotificationRestoration<T>(
  restore: () => Promise<T>,
  signal: AbortSignal,
  offerRetry?: (delay: number, retry: () => void) => () => void,
): Promise<T> {
  let attempt = 0;
  while (true) {
    if (signal.aborted) throw new SessionSupersededError();
    try {
      const registration = await abortableRegistration(signal);
      if (signal.aborted) throw new SessionSupersededError();
      if (!registration) break;
      if (!registration.active) throw new Error('Notification worker is not active');
      await notificationHandshake(registration.active, signal);
      break;
    } catch (error) {
      if (signal.aborted) throw new SessionSupersededError();
      attempt += 1;
      console.warn('[notification] restoration retry', { attempt, error });
      await new Promise<void>((resolve, reject) => {
        const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 4), 10000);
        let release: (() => void) | undefined;
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          release?.();
        };
        const abort = () => { cleanup(); reject(new SessionSupersededError()); };
        const retry = () => { cleanup(); resolve(); };
        const timer = setTimeout(retry, delay);
        release = offerRetry?.(delay, retry);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  if (signal.aborted) throw new SessionSupersededError();
  return restore();
}

async function abortableRegistration(signal: AbortSignal): Promise<ServiceWorkerRegistration | undefined> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new SessionSupersededError());
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    // The browser query cannot be cancelled; consume its result without continuing
    // restoration after cancellation, and release the abort listener on settlement.
    getPushWorkerRegistration().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

async function notificationHandshake(worker: ServiceWorker, signal: AbortSignal): Promise<void> {
  const channel = new MessageChannel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(new SessionSupersededError());
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      timer = setTimeout(() => reject(new Error('Notification restoration timed out')), 20000);
      channel.port1.onmessage = ({ data }) => {
        if (data?.ok === true) resolve();
        else reject(new Error('Notification restoration failed'));
      };
      worker.postMessage({ type: SOMS_NOTIF_MSG.RESTORE }, [channel.port2]);
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
    channel.port1.close();
    channel.port2.close();
  }
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
