import { SessionLifecycleService } from './session-lifecycle.service';
import { createSessionCacheDescriptor } from './session/session-identity';
import { TauriNotificationAdapter } from './tauri-notification.adapter';

const invoke = vi.fn().mockResolvedValue(undefined);

describe('desktop notification dismissal adapter', () => {
  let lifecycle: SessionLifecycleService;
  beforeEach(() => {
    lifecycle = new SessionLifecycleService();
    lifecycle.bindSession(createSessionCacheDescriptor().id);
    invoke.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('__TAURI__', { core: { invoke } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports presentation changes without specifying a notification operation', async () => {
    const adapter = new TauriNotificationAdapter(lifecycle);
    await adapter.presentationChanged();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('desktop_notification_presentation_changed', undefined);
    expect('showDescriptor' in adapter).toBe(false);
  });

  it('retains navigation receipts when clearing notifications', async () => {
    await new TauriNotificationAdapter(lifecycle).clear();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('desktop_notifications_clear', { resetNavigation: false });
  });

  it('stops queued observations on dispose without clearing system notifications', async () => {
    const adapter = new TauriNotificationAdapter(lifecycle);
    const pending = adapter.presentationChanged();
    adapter.dispose();
    await pending;
    expect(invoke).not.toHaveBeenCalled();
    expect('generation' in adapter).toBe(false);
  });

  it('does not dispatch queued dismissal after its page session ends', async () => {
    const pending = new TauriNotificationAdapter(lifecycle).presentationChanged();
    lifecycle.invalidateSession();
    await pending;
    expect(invoke).not.toHaveBeenCalled();
  });
});
