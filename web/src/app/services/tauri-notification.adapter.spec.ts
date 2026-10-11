import { apiOrigin } from './runtime';
import { TauriNotificationAdapter } from './tauri-notification.adapter';
import type { NotificationDescriptor } from './notification-descriptor.model';

const tauriInvoke = vi.fn().mockResolvedValue(undefined);

describe('desktop notification command ordering', () => {
  const descriptor: NotificationDescriptor = {
    tag: 'soms-thread-7',
    kind: 'thread-message',
    title: 'Peer',
    body: 'Hello',
    count: 1,
    lang: 'en',
    icon: null,
    renotify: true,
    data: { threadId: 7 },
  };
  beforeEach(() => {
    apiOrigin.set('https://primary');
    tauriInvoke.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('__TAURI__', { core: { invoke: tauriInvoke } });
  });
  afterEach(() => { vi.unstubAllGlobals(); apiOrigin.set(''); });

  it('passes the originating session and supports zero-count updates', async () => {
    const adapter = new TauriNotificationAdapter(() => 11);
    await adapter.showDescriptor({ ...descriptor, count: 0 });
    expect(tauriInvoke).toHaveBeenCalledWith('desktop_notification_update', {
      notification: {
        threadId: 7,
        sessionId: 11,
        origin: 'https://primary',
        title: 'Peer',
        body: 'Hello',
        count: 0,
        silent: false,
      },
    });
  });
  it('clearing invalidates queued posts and preserves pending navigation on focus', async () => {
    const adapter = new TauriNotificationAdapter(() => 11);
    const post = adapter.showDescriptor(descriptor);
    const clear = adapter.clear();
    await Promise.all([post, clear]);
    expect(tauriInvoke).toHaveBeenCalledTimes(1);
    expect(tauriInvoke).toHaveBeenCalledWith('desktop_notifications_clear', {
      resetNavigation: false,
    });
  });
  it('rejects unscoped and queued old-session posts', async () => {
    let sessionId: number | null = null;
    const adapter = new TauriNotificationAdapter(() => sessionId);
    await adapter.showDescriptor(descriptor);
    sessionId = 11;
    const post = adapter.showDescriptor(descriptor);
    sessionId = 12;
    await post;
    expect(tauriInvoke).not.toHaveBeenCalled();
  });
  it('captures the primary origin and rejects queued old-server posts', async () => {
    const adapter = new TauriNotificationAdapter(() => 11);
    const post = adapter.showDescriptor(descriptor);
    apiOrigin.set('https://other');
    await post;
    expect(tauriInvoke).not.toHaveBeenCalled();
  });
  it('waits for an in-flight post before clearing', async () => {
    let release!: () => void;
    vi.mocked(tauriInvoke).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const adapter = new TauriNotificationAdapter(() => 11);
    const post = adapter.showDescriptor(descriptor);
    await Promise.resolve();
    const clear = adapter.clear();
    expect(tauriInvoke).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([post, clear]);
    expect(tauriInvoke).toHaveBeenLastCalledWith(
      'desktop_notifications_clear',
      { resetNavigation: false },
    );
  });
});
