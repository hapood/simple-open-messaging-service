import {
  activePageClientId,
  ACTIVE_PAGE_LOCK,
  runAsActivePage,
} from './active-page';

describe('active page ownership', () => {
  let root: HTMLElement;
  let events: EventTarget;
  let locksDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      get: () => undefined,
    });
    root = document.createElement('app-root');
    document.body.appendChild(root);
    events = new EventTarget();
    vi.spyOn(window, 'addEventListener').mockImplementation(
      events.addEventListener.bind(events),
    );
  });

  afterEach(() => {
    root.remove();
    vi.restoreAllMocks();
    if (locksDescriptor)
      Object.defineProperty(navigator, 'locks', locksDescriptor);
    else Reflect.deleteProperty(navigator, 'locks');
  });

  it('starts immediately with ownership and keeps the lock after bootstrap', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const released = vi.fn();
    const request = vi.fn((_name, _options, callback) =>
      callback({ name: ACTIVE_PAGE_LOCK }).then(released),
    );
    vi.spyOn(navigator, 'locks', 'get').mockReturnValue({
      request,
    } as unknown as LockManager);

    void runAsActivePage(start);
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(released).not.toHaveBeenCalled();
  });

  it('does not bootstrap a waiting page until the browser grants ownership', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    let grant!: () => void;
    const request = vi.fn((_name, options, callback) => {
      if (options.ifAvailable) return callback(null);
      return new Promise<void>(() => {
        grant = () => {
          void callback({ name: ACTIVE_PAGE_LOCK });
        };
      });
    });
    vi.spyOn(navigator, 'locks', 'get').mockReturnValue({
      request,
    } as unknown as LockManager);

    void runAsActivePage(start);
    expect(start).not.toHaveBeenCalled();
    expect(root.querySelector('[role="status"]')).not.toBeNull();
    grant();
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued acquisition when the waiting document closes', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    let signal!: AbortSignal;
    const request = vi.fn((_name, options, callback) => {
      if (options.ifAvailable) return callback(null);
      signal = options.signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    });
    vi.spyOn(navigator, 'locks', 'get').mockReturnValue({
      request,
    } as unknown as LockManager);

    const waiting = runAsActivePage(start);
    events.dispatchEvent(new Event('pagehide'));
    await waiting;
    expect(signal.aborted).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it('does not start without Web Locks', async () => {
    vi.spyOn(navigator, 'locks', 'get').mockReturnValue(
      undefined as unknown as LockManager,
    );
    const start = vi.fn();
    await runAsActivePage(start);
    expect(start).not.toHaveBeenCalled();
    expect(root.querySelector('[role="status"]')).not.toBeNull();
  });

  it('routes only to the held page lock, not a pending or unrelated lock', async () => {
    const query = vi.fn().mockResolvedValue({
      held: [
        { name: 'soms-notification-projection', clientId: 'worker' },
        { name: ACTIVE_PAGE_LOCK, clientId: 'owner' },
      ],
      pending: [{ name: ACTIVE_PAGE_LOCK, clientId: 'waiting' }],
    });
    const locks = { query } as unknown as LockManager;
    expect(await activePageClientId(locks)).toBe('owner');
    query.mockResolvedValue({
      held: [],
      pending: [{ name: ACTIVE_PAGE_LOCK, clientId: 'waiting' }],
    });
    expect(await activePageClientId(locks)).toBeUndefined();
  });
});
