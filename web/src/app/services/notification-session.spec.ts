import { notificationDouble, registrationDouble, workerDouble } from './service-worker-test-doubles';
import { clearSessionNotifications, withNotificationRestoration } from './notification-session';
import { SOMS_NOTIF_MSG } from './sw-notif-protocol';
const tauriInvoke = vi.fn().mockResolvedValue(undefined);
const closeNotification = vi.fn();

describe('session notification cleanup', () => {
  let locksDescriptor: PropertyDescriptor | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      get: () => undefined,
    });
    vi.spyOn(navigator.serviceWorker, 'getRegistration').mockResolvedValue(registrationDouble({
      scope: new URL('/push/', location.href).href,
      getNotifications: async () => [
        notificationDouble('soms-thread-7', closeNotification),
      ],
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (locksDescriptor)
      Object.defineProperty(navigator, 'locks', locksDescriptor);
    else Reflect.deleteProperty(navigator, 'locks');
  });

  it('enters worker recovery before local restore and HELLO without draining in-flight work', async () => {
    const restore = vi.fn().mockResolvedValue(true);
    let reply!: MessagePort;
    const postMessage = vi.fn((_data, ports) => { reply = ports[0]; });
    vi.mocked(navigator.serviceWorker.getRegistration).mockResolvedValue(registrationDouble({
      scope: new URL('/push/', location.href).href,
      active: workerDouble(postMessage),
    }));
    const restoring = withNotificationRestoration(restore, new AbortController().signal);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    expect(postMessage.mock.calls[0][0]).toEqual({ type: SOMS_NOTIF_MSG.RESTORE });
    expect(restore).not.toHaveBeenCalled();
    reply.postMessage({ ok: true });
    expect(await restoring).toBe(true);
    expect(restore).toHaveBeenCalledOnce();
    expect(closeNotification).not.toHaveBeenCalled();
  });

  it('does not send RESTORE to the root app-shell worker', async () => {
    const restore = vi.fn().mockResolvedValue(true);
    const postMessage = vi.fn();
    vi.mocked(navigator.serviceWorker.getRegistration).mockResolvedValue(registrationDouble({
      scope: new URL('/', location.href).href,
      active: workerDouble(postMessage),
    }));
    expect(await withNotificationRestoration(restore, new AbortController().signal)).toBe(true);
    expect(postMessage).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledOnce();
  });

  it('retries timeouts with a fresh worker and cancels without restoring', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    const restore = vi.fn();
    const first = vi.fn();
    const second = vi.fn();
    const registration = (postMessage: typeof first) => registrationDouble({
      scope: new URL('/push/', location.href).href,
      active: workerDouble(postMessage),
    });
    vi.mocked(navigator.serviceWorker.getRegistration)
      .mockResolvedValueOnce(registration(first))
      .mockResolvedValue(registration(second));
    const result = withNotificationRestoration(restore, controller.signal);
    const rejected = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(21000);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(22000);
    expect(second).toHaveBeenCalledTimes(2);
    controller.abort();
    await rejected;
    expect(restore).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('manual retry skips only backoff and releases its callback', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    let retry!: () => void;
    const release = vi.fn();
    const postMessage = vi.fn();
    vi.mocked(navigator.serviceWorker.getRegistration)
      .mockResolvedValueOnce(registrationDouble())
      .mockResolvedValue(registrationDouble({
        scope: new URL('/push/', location.href).href,
        active: workerDouble(postMessage),
      }));
    const result = withNotificationRestoration(vi.fn(), controller.signal, (_delay, wake) => {
      retry = wake;
      return release;
    });
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(retry).toBeDefined());
    retry();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    expect(release).toHaveBeenCalledOnce();
    controller.abort();
    await rejected;
  });

  it('cancels while registration lookup is pending without publishing its late result', async () => {
    let finish!: (value: ServiceWorkerRegistration | undefined) => void;
    vi.mocked(navigator.serviceWorker.getRegistration).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const restore = vi.fn();
    const result = withNotificationRestoration(restore, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow();
    finish(undefined);
    await Promise.resolve();
    expect(restore).not.toHaveBeenCalled();
  });

  it('does not retry failures from the local restore callback', async () => {
    vi.mocked(navigator.serviceWorker.getRegistration).mockResolvedValue(undefined);
    const restore = vi.fn().mockRejectedValue(new Error('local failure'));
    await expect(withNotificationRestoration(restore, new AbortController().signal)).rejects.toThrow('local failure');
    expect(restore).toHaveBeenCalledOnce();
  });

  it('restores without a notification worker when none is registered', async () => {
    const restore = vi.fn().mockResolvedValue(true);
    vi.mocked(navigator.serviceWorker.getRegistration).mockResolvedValue(undefined);
    expect(await withNotificationRestoration(restore, new AbortController().signal)).toBe(true);
    expect(restore).toHaveBeenCalledOnce();
  });

  it('resets desktop pending navigation without sending an epoch', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    vi.stubGlobal('__TAURI__', { core: { invoke: tauriInvoke } });
    await clearSessionNotifications();
    expect(tauriInvoke).toHaveBeenCalledExactlyOnceWith(
      'desktop_notifications_clear',
      { resetNavigation: true },
    );
    expect(closeNotification).not.toHaveBeenCalled();
  });

  it('waits for the browser projection lock before clearing', async () => {
    let grant!: () => void;
    const request = vi.fn(
      (_name, callback) =>
        new Promise<void>((resolve, reject) => {
          grant = () => {
            Promise.resolve(callback()).then(resolve, reject);
          };
        }),
    );
    vi.spyOn(navigator, 'locks', 'get').mockReturnValue({
      request,
    } as unknown as LockManager);
    const clearing = clearSessionNotifications();
    expect(closeNotification).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      'soms-notification-projection',
      expect.any(Function),
    );
    grant();
    await clearing;
    expect(closeNotification).toHaveBeenCalledTimes(1);
  });

  it('still clears when Web Locks are unavailable', async () => {
    vi.spyOn(navigator, 'locks', 'get').mockReturnValue(
      undefined as unknown as LockManager,
    );
    await clearSessionNotifications();
    expect(closeNotification).toHaveBeenCalledTimes(1);
  });
});
