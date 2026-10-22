import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  provideHttpClientTesting,
  HttpTestingController,
} from '@angular/common/http/testing';
import { vi } from 'vitest';
import {
  PushRegistrationService,
  type PushRegistration,
} from './push-registration.service';
import { PreferenceStore } from './preference-store.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { apiOrigin } from './runtime';

describe('Shared push registration recovery', () => {
  let service: PushRegistrationService;
  let http: HttpTestingController;
  let local: PushRegistration | null;
  let create: ReturnType<
    typeof vi.fn<(replace: boolean) => Promise<PushRegistration | null>>
  >;
  let storage: Map<string, unknown>;
  const settle = async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };
  const hello = (rev: number, sessionId = 5) =>
    service.onEvent('HELLO', { sessionId, pushSubscriptionRev: rev });
  const success = (rev: number, sessionId = 5) => ({
    code: 0,
    data: { sessionId, pushSubscriptionRev: rev, registered: true },
  });
  const pending = () =>
    http.expectOne((request) => request.url.endsWith('/devices/register'));

  beforeEach(() => {
    storage = new Map();
    local = { platform: 'WEB', token: 'old', p256dh: 'key', auth: 'auth' };
    create = vi.fn(
      async (_replace: boolean) =>
        (local = {
          platform: 'WEB',
          token: 'new',
          p256dh: 'key',
          auth: 'auth',
        }),
    );
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: PreferenceStore,
          useValue: {
            get: async (_scope: string, key: string) => storage.get(key),
            remove: async (_scope: string, key: string) => {
              storage.delete(key);
            },
            set: async (_scope: string, key: string, value: unknown) => {
              storage.set(key, value);
            },
          },
        },
      ],
    });
    service = TestBed.inject(PushRegistrationService);
    http = TestBed.inject(HttpTestingController);
    service.setAdapter({ read: async () => local, create });
  });
  afterEach(() => {
    TestBed.inject(SessionLifecycleService).invalidateSession();
    try {
      http.verify();
    } finally {
      vi.useRealTimers();
      TestBed.resetTestingModule();
    }
  });

  it('initial revision 1 registers an existing subscription without replacing it', async () => {
    hello(1);
    await settle();
    const request = pending();
    expect(request.request.body).toMatchObject({
      sessionId: 5,
      pushSubscriptionRev: 1,
      token: 'old',
    });
    request.flush(success(1));
    await settle();
    hello(1);
    await settle();
    expect(create).not.toHaveBeenCalled();
    http.expectNone((request) => request.url.endsWith('/devices/register'));
  });

  it('coalesces duplicate invalidations and retries upload without replacing twice', async () => {
    vi.useFakeTimers();
    hello(2);
    hello(2);
    await settle();
    const request = pending();
    expect(request.request.body.token).toBe('new');
    request.flush('unavailable', { status: 503, statusText: 'Unavailable' });
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    pending().flush(success(2));
    await settle();
    expect(create).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('ignores an older revision and another session notification', async () => {
    hello(3);
    await settle();
    pending().flush(success(3));
    await settle();
    service.onEvent('PUSH_SUBSCRIPTION_CHANGED', {
      sessionId: 5,
      pushSubscriptionRev: 2,
    });
    service.onEvent('PUSH_SUBSCRIPTION_CHANGED', {
      sessionId: 6,
      pushSubscriptionRev: 4,
    });
    await settle();
    http.expectNone((request) => request.url.endsWith('/devices/register'));
  });

  it('reconciles a server revision that advanced while registering', async () => {
    hello(1);
    await settle();
    pending().flush({
      code: 0,
      data: { sessionId: 5, pushSubscriptionRev: 2, registered: false },
    });
    await settle();
    expect(create).toHaveBeenCalledExactlyOnceWith(true);
    pending().flush(success(2));
    await settle();
  });

  it('does not let a late registration response acknowledge a new session', async () => {
    hello(1);
    await settle();
    const old = pending();
    TestBed.inject(SessionLifecycleService).invalidateSession();
    hello(1, 6);
    old.flush(success(1));
    await settle();
    const next = pending();
    expect(next.request.body.sessionId).toBe(6);
    next.flush(success(1, 6));
    await settle();
  });

  it('reuses the prepared token after coordinator reload at a recovery revision', async () => {
    storage.set(`push-registration:${apiOrigin()}/api/v1`, {
      sessionId: 5,
      rev: 2,
      phase: 'prepared',
      token: 'old',
    });
    hello(2);
    await settle();
    pending().flush(success(2));
    await settle();
    expect(create).not.toHaveBeenCalled();
  });

  it('does not mistake a denied recovery attempt for a prepared subscription', async () => {
    local = null;
    create.mockResolvedValueOnce(null);
    hello(2);
    await settle();
    expect(storage.size).toBe(0);
    local = { platform: 'WEB', token: 'old', p256dh: 'key', auth: 'auth' };
    service.refresh();
    await settle();
    expect(create).toHaveBeenLastCalledWith(true);
    pending().flush(success(2));
    await settle();
  });

  it('uses the same protocol for Android automatic token rotation', async () => {
    local = { platform: 'ANDROID', token: 'android-1' };
    hello(1);
    await settle();
    pending().flush(success(1));
    await settle();
    local = { platform: 'ANDROID', token: 'android-2' };
    service.refresh();
    await settle();
    const request = pending();
    expect(request.request.body).toMatchObject({
      platform: 'ANDROID',
      token: 'android-2',
      pushSubscriptionRev: 1,
    });
    request.flush(success(1));
    await settle();
    expect(create).not.toHaveBeenCalled();
  });
});
