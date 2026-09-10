import type { NotificationDescriptor } from './notification-descriptor.model';
import type { Mock } from 'vitest';
import { BrowserNotificationAdapter } from './browser-notification.adapter';

/** The adapter renders through the push-SW registration (`registration.showNotification`) so the SW's
 *  `notificationclick` fires. These tests stub the registration + the `Notification` global (the permission
 *  gate + the fallback constructor); the live SW click flow is verified manually. */
describe('BrowserNotificationAdapter (SW registration path)', () => {
  const prefs = {
    enabled: () => true,
    sound: () => true,
  } as unknown as ConstructorParameters<typeof BrowserNotificationAdapter>[0];
  let showNotification: Mock;
  let getRegistration: Mock;
  let notificationCreates: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const RealNotification = g.Notification;

  /** A fake SW registration carrying spied show/getNotifications. */
  function fakeReg(
    notifs: Array<{
      tag: string;
      close: Mock;
    }> = [],
  ): ServiceWorkerRegistration {
    return {
      showNotification,
      getNotifications: () => Promise.resolve(notifs),
    } as unknown as ServiceWorkerRegistration;
  }

  beforeEach(() => {
    showNotification = vi
      .fn()
      .mockName('showNotification')
      .mockResolvedValue(undefined);
    getRegistration = vi.fn().mockName('getRegistration');
    notificationCreates = 0;
    // Force the permission gate to 'granted' + give the fallback `new Notification` a counting no-op stub.
    g.Notification = class {
      static permission = 'granted';
      public onclick: (() => void) | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
      constructor(
        public title: string,
        public options?: any,
      ) {
        notificationCreates++;
      }
      addEventListener() {}
      close() {}
    };
    if ('serviceWorker' in navigator) {
      vi.spyOn(navigator.serviceWorker, 'getRegistration').mockImplementation(
        getRegistration,
      );
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (navigator as any).serviceWorker = { getRegistration };
    }
  });

  afterEach(() => {
    g.Notification = RealNotification;
  });

  const threadDescriptor: NotificationDescriptor = {
    tag: 'soms-thread-7',
    kind: 'thread-message',
    title: 'Alice',
    body: 'sent you 3 messages',
    count: 3,
    lang: 'en',
    icon: null,
    renotify: true,
    data: { threadId: 7, seq: 3 },
  };

  it('renders through the worker registration without action buttons', async () => {
    getRegistration.mockResolvedValue(fakeReg());
    const adapter = new BrowserNotificationAdapter(prefs);
    await adapter.showDescriptor(threadDescriptor);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][1]).not.toHaveProperty('actions');
    expect(notificationCreates).toBe(0); // fallback NOT taken
    const [title, options] = vi.mocked(showNotification).mock.lastCall!;
    expect(title).toBe('Alice');
    expect(options).toEqual(
      expect.objectContaining({
        tag: 'soms-thread-7',
        body: 'sent you 3 messages',
        data: { threadId: 7, seq: 3 },
      }),
    );
  });

  it('clear() closes every soms-* notification on the registration, leaving foreign tags alone', async () => {
    const soms = { tag: 'soms-thread-7', close: vi.fn().mockName('close7') };
    const foreign = {
      tag: 'other-app',
      close: vi.fn().mockName('closeOther'),
    };
    getRegistration.mockResolvedValue(fakeReg([soms, foreign]));
    const adapter = new BrowserNotificationAdapter(prefs);
    await adapter.clear();
    expect(soms.close).toHaveBeenCalledTimes(1);
    expect(foreign.close).not.toHaveBeenCalled();
  });

  it('a zero count closes only its thread card without showing another notification', async () => {
    const current = { tag: 'soms-thread-7', close: vi.fn() };
    const other = { tag: 'soms-thread-8', close: vi.fn() };
    getRegistration.mockResolvedValue(fakeReg([current, other]));
    await new BrowserNotificationAdapter(prefs).showDescriptor({
      ...threadDescriptor,
      count: 0,
    });
    expect(current.close).toHaveBeenCalledOnce();
    expect(other.close).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('falls back to in-page new Notification (no actions) when no SW registration is available', async () => {
    getRegistration.mockResolvedValue(null);
    const adapter = new BrowserNotificationAdapter(prefs);
    await adapter.showDescriptor(threadDescriptor);
    expect(showNotification).not.toHaveBeenCalled();
    expect(notificationCreates).toBe(1); // fallback path taken
  });

  it('clear() awaits an in-flight showNotification before closing (no stray card)', async () => {
    // Hold showNotification open so the render stays in-flight while clear() runs.
    let resolveShow: () => void = () => {};
    showNotification.mockReturnValue(
      new Promise<void>((r) => (resolveShow = r)),
    );
    getRegistration.mockResolvedValue(fakeReg());
    const adapter = new BrowserNotificationAdapter(prefs);
    const showed = adapter.showDescriptor(threadDescriptor); // pending — show not resolved
    const cleared = adapter.clear();
    let clearDone = false;
    cleared.then(() => (clearDone = true));
    await new Promise((r) => setTimeout(r)); // drain microtasks
    expect(clearDone).toBe(false); // clear blocked on the in-flight render
    resolveShow(); // render resolves → clear can proceed
    await Promise.all([showed, cleared]);
    expect(clearDone).toBe(true);
  });
});
