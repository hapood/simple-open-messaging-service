import {
  registrationDouble,
  subscriptionDouble,
  workerDouble,
} from './service-worker-test-doubles';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { AppStateStorage } from './preference-storage';
import { ToastService } from './toast.service';
import { SessionStore } from './session/session-store';
import { SessionLifecycleService } from './session-lifecycle.service';
import {
  createSessionCacheDescriptor,
  SessionSupersededError,
  type LoginSessionId,
} from './session/session-identity';
import { WebPushService } from './web-push.service';

describe('WebPushService device ID', () => {
  let service: WebPushService;
  let preferences: AppStateStorage;

  function createRuntime(sessionId?: LoginSessionId): void {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        { provide: TranslocoService, useValue: { translate: () => '' } },
        { provide: ToastService, useValue: { warn: () => {} } },
      ],
    });
    if (sessionId) {
      TestBed.inject(SessionLifecycleService).bindSession(sessionId);
    }
    service = TestBed.inject(WebPushService);
  }

  beforeEach(async () => {
    preferences = new AppStateStorage();
    await preferences.remove('pushDeviceId');
    createRuntime();
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

  it('rejects an invalidated identity read and registers only in a fresh successor runtime', async () => {
    const session = createSessionCacheDescriptor();
    const successor = createSessionCacheDescriptor();
    const lifecycle = TestBed.inject(SessionLifecycleService);
    lifecycle.bindSession(session.id);
    vi.spyOn(Notification, 'permission', 'get').mockReturnValue('granted');
    const registration = registrationDouble({ active: workerDouble(vi.fn()) });
    const register = vi
      .spyOn(navigator.serviceWorker, 'register')
      .mockResolvedValue(registration);
    const read = vi
      .spyOn(SessionStore.prototype, 'read')
      .mockImplementationOnce(async () => {
        lifecycle.invalidateSession();
        expect(() => lifecycle.bindSession(successor.id)).toThrow(
          SessionSupersededError,
        );
        TestBed.resetTestingModule();
        createRuntime(successor.id);
        return {
          lifecycleState: 'active',
          session,
          identity: { userId: 1, serverSessionId: 2 },
        };
      });
    const oldService = service;
    expect(await oldService.worker()).toBeNull();
    expect(register).not.toHaveBeenCalled();
    expect(await oldService.worker()).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue({
      lifecycleState: 'active',
      session: successor,
      identity: { userId: 1, serverSessionId: 3 },
    });
    expect(await service.worker()).toBe(registration);
    expect(register).toHaveBeenCalledExactlyOnceWith('/push/sw-push.js', {
      scope: '/push/',
      updateViaCache: 'none',
    });
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
