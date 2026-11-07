import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { PreferenceStore } from './preference-store.service';
import { ToastService } from './toast.service';
import { SessionStore } from './session/session-store';
import { SessionLifecycleService } from './session-lifecycle.service';
import { createSessionCacheDescriptor } from './session/session-identity';
import { WebPushService } from './web-push.service';

describe('WebPushService device ID', () => {
  let service: WebPushService;
  let preferences: PreferenceStore;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        { provide: TranslocoService, useValue: { translate: () => '' } },
        { provide: ToastService, useValue: { warn: () => {} } },
      ],
    });
    preferences = TestBed.inject(PreferenceStore);
    await preferences.remove('device', 'device_id');
    service = TestBed.inject(WebPushService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('does not register a push worker before login', async () => {
    const read = vi.spyOn(SessionStore.prototype, 'read');
    expect(await service.worker()).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('does not register a worker before the login identity is confirmed', async () => {
    const session = createSessionCacheDescriptor();
    const lifecycle = TestBed.inject(SessionLifecycleService);
    lifecycle.bindSession(session.id);
    vi.spyOn(SessionStore.prototype, 'read').mockResolvedValue({
      version: 1, phase: 'active', session, identity: null, pendingCleanup: [],
    });
    expect(await service.worker()).toBeNull();
  });

  it('rejects a login invalidated while reading its durable identity', async () => {
    const session = createSessionCacheDescriptor();
    const lifecycle = TestBed.inject(SessionLifecycleService);
    lifecycle.bindSession(session.id);
    vi.spyOn(SessionStore.prototype, 'read').mockImplementation(async () => {
      lifecycle.invalidateSession();
      return { version: 1, phase: 'active', session,
        identity: { userId: 1, serverSessionId: 2 }, pendingCleanup: [] };
    });
    expect(await service.worker()).toBeNull();
  });

  it('logout unsubscribes without registering a worker', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const getRegistration = vi.spyOn(navigator.serviceWorker, 'getRegistration')
      .mockResolvedValue({ pushManager: { getSubscription: async () => ({ unsubscribe }) } } as unknown as ServiceWorkerRegistration);
    const register = vi.spyOn(navigator.serviceWorker, 'register');
    await service.unsubscribe();
    expect(getRegistration).toHaveBeenCalledWith('/push/');
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(register).not.toHaveBeenCalled();
  });

  it('does not claim a failed unsubscribe succeeded', async () => {
    vi.spyOn(navigator.serviceWorker, 'getRegistration')
      .mockResolvedValue({ pushManager: { getSubscription: async () => ({ unsubscribe: async () => false }) } } as unknown as ServiceWorkerRegistration);
    await expect(service.unsubscribe()).rejects.toThrow('Could not cancel push subscription');
  });

  it('creates and persists one ID for concurrent registrations', async () => {
    const [first, second] = await Promise.all([
      service['clientDeviceId'](),
      service['clientDeviceId'](),
    ]);

    expect(first).toBe(second);
    expect(await preferences.get('device', 'device_id')).toBe(first);
  });

  it('reuses a stored device ID', async () => {
    await preferences.set('device', 'device_id', 'existing-device');

    expect(await service['clientDeviceId']()).toBe('existing-device');
  });
});
