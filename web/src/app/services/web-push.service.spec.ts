import {
  registrationDouble,
  subscriptionDouble,
} from './service-worker-test-doubles';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { AppStateStorage } from './preference-storage';
import { ToastService } from './toast.service';
import { SessionStore } from './session/session-store';
import { SessionLifecycleService } from './session-lifecycle.service';
import { createSessionCacheDescriptor } from './session/session-identity';
import { WebPushService } from './web-push.service';

describe('WebPushService device ID', () => {
  let service: WebPushService;
  let preferences: AppStateStorage;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        { provide: TranslocoService, useValue: { translate: () => '' } },
        { provide: ToastService, useValue: { warn: () => {} } },
      ],
    });
    preferences = new AppStateStorage();
    await preferences.remove('pushDeviceId');
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
      lifecycleState: 'active',
      session,
      identity: null,
    });
    expect(await service.worker()).toBeNull();
  });

  it('rejects a login invalidated while reading its durable identity', async () => {
    const session = createSessionCacheDescriptor();
    const lifecycle = TestBed.inject(SessionLifecycleService);
    lifecycle.bindSession(session.id);
    vi.spyOn(SessionStore.prototype, 'read').mockImplementation(async () => {
      lifecycle.invalidateSession();
      return {
        lifecycleState: 'active',
        session,
        identity: { userId: 1, serverSessionId: 2 },
      };
    });
    expect(await service.worker()).toBeNull();
  });

  it('logout unsubscribes without registering a worker', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const getRegistration = vi
      .spyOn(navigator.serviceWorker, 'getRegistration')
      .mockResolvedValue(
        registrationDouble({
          scope: new URL('/push/', location.href).href,
          pushManager: {
            ...registrationDouble().pushManager,
            getSubscription: async () => subscriptionDouble(unsubscribe),
          },
        }),
      );
    const register = vi.spyOn(navigator.serviceWorker, 'register');
    await service.unsubscribe();
    expect(getRegistration).toHaveBeenCalledWith(
      new URL('/push/', location.href).href,
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(register).not.toHaveBeenCalled();
  });

  it('does not claim a failed unsubscribe succeeded', async () => {
    vi.spyOn(navigator.serviceWorker, 'getRegistration').mockResolvedValue(
      registrationDouble({
        scope: new URL('/push/', location.href).href,
        pushManager: {
          ...registrationDouble().pushManager,
          getSubscription: async () => subscriptionDouble(async () => false),
        },
      }),
    );
    await expect(service.unsubscribe()).rejects.toThrow(
      'Could not cancel push subscription',
    );
  });

  it('creates and persists one ID for concurrent registrations', async () => {
    const [first, second] = await Promise.all([
      service['clientDeviceId'](),
      service['clientDeviceId'](),
    ]);

    expect(first).toBe(second);
    expect(await preferences.get('pushDeviceId')).toBe(first);
  });

  it('reuses a stored device ID', async () => {
    await preferences.set('pushDeviceId', 'existing-device');

    expect(await service['clientDeviceId']()).toBe('existing-device');
  });
});
