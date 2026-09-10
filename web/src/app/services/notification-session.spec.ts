import { clearSessionNotifications } from './notification-session';
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
    vi.spyOn(navigator.serviceWorker, 'getRegistration').mockResolvedValue({
      getNotifications: async () => [
        { tag: 'soms-thread-7', close: closeNotification },
      ],
    } as unknown as ServiceWorkerRegistration);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (locksDescriptor)
      Object.defineProperty(navigator, 'locks', locksDescriptor);
    else Reflect.deleteProperty(navigator, 'locks');
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
