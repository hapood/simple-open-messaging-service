/** Complete DOM-shaped test doubles: missing capabilities fail loudly rather than
 * silently passing through an assertion to ServiceWorkerRegistration. */
const unsupported = (): never => { throw new Error('Unexpected service worker capability'); };

export function notificationDouble(tag: string, close: () => void): Notification {
  return Object.assign(new EventTarget(), {
    body: '', data: null, dir: 'auto' as const, icon: '', lang: '',
    onclick: null, onclose: null, onerror: null, onshow: null,
    requireInteraction: false, silent: null, tag, title: '', close,
  });
}

export function subscriptionDouble(unsubscribe: () => Promise<boolean>): PushSubscription {
  return {
    endpoint: 'https://push.example.test/subscription', expirationTime: null,
    options: { applicationServerKey: null, userVisibleOnly: true },
    getKey: unsupported, toJSON: unsupported, unsubscribe,
  };
}

export function workerDouble(postMessage: ServiceWorker['postMessage']): ServiceWorker {
  return Object.assign(new EventTarget(), {
    scriptURL: new URL('/push/sw-push.js', location.href).href,
    state: 'activated' as const,
    onstatechange: null,
    onerror: null,
    postMessage,
  });
}

export function registrationDouble(
  overrides: Partial<ServiceWorkerRegistration> = {},
): ServiceWorkerRegistration {
  const registration: ServiceWorkerRegistration = Object.assign(new EventTarget(), {
    scope: new URL('/push/', location.href).href,
    active: null,
    installing: null,
    waiting: null,
    onupdatefound: null,
    updateViaCache: 'none' as const,
    cookies: { subscribe: unsupported, unsubscribe: unsupported, getSubscriptions: unsupported },
    navigationPreload: { enable: unsupported, disable: unsupported, getState: unsupported, setHeaderValue: unsupported },
    pushManager: { getSubscription: unsupported, subscribe: unsupported, permissionState: unsupported },
    getNotifications: async (): Promise<Notification[]> => [],
    showNotification: unsupported,
    unregister: unsupported,
    update: async () => registration,
  }, overrides);
  return registration;
}
