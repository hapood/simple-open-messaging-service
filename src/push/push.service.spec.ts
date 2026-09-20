import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the web-push lib so we can assert the exact payload sendNotification receives. vi.hoisted keeps
// the spy reference stable across vitest's mock-factory hoisting.
const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn() }));
vi.mock('web-push', () => ({ default: { sendNotification } }));

import { PushService } from './push.service.js';

/**
 * Pins the identity-only push payloads — the contract every receiver (Android onMessageReceived,
 * Web sw-push.js) routes on. A regression here (a stray body/preview field, a renamed `type`) silently
 * breaks the wake-up routing on every platform.
 *
 * FCM is disabled by an injected missing file path, so these
 * cases exercise the Web Push branch — the payload is identical across transports (FCM data = the same
 * flat string map; Web Push = its JSON.stringify).
 */
describe('PushService — identity-only payloads', () => {
  let svc: PushService;
  let registrations: ReturnType<typeof vi.fn>;
  let settings: {
    isWebPushConfigured: boolean;
    getVapid: ReturnType<typeof vi.fn>;
  };
  let sse: { isSessionOnline: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    sendNotification.mockReset();
    registrations = vi.fn().mockResolvedValue([]);
    settings = {
      isWebPushConfigured: true,
      getVapid: vi.fn(() => ({
        subject: 'mailto:t@t',
        publicKey: 'pk',
        privateKey: 'sk',
      })),
    };
    sse = { isSessionOnline: vi.fn(() => false) };
    svc = new PushService(
      {
        db: {},
      } as never,
      sse as never,
      settings as never,
      '/definitely-not-present/soms-firebase-service-account.json',
    );
    svc['registrations'] = registrations;
  });

  it.each([404, 410])(
    'requests session recovery on Web Push HTTP %s',
    async (statusCode) => {
      const snapshot = {
        userId: 1,
        sessionId: 10,
        pushSubscriptionRev: 3,
        token: 'https://push/dead',
        platform: 'WEB',
        webP256dh: 'key',
        webAuth: 'auth',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60000),
      };
      registrations.mockResolvedValue([snapshot]);
      sendNotification.mockRejectedValue({ statusCode });
      const invalidate = vi
        .spyOn(svc, 'invalidateSubscription')
        .mockResolvedValue();
      await svc.dispatchForMessage([{ userId: 1, threadFeedEndId: 9 }]);
      expect(invalidate).toHaveBeenCalledExactlyOnceWith(snapshot);
    },
  );

  it('uses the same recovery for an unregistered Android token', async () => {
    const snapshot = {
      userId: 1,
      sessionId: 10,
      pushSubscriptionRev: 3,
      token: 'android-dead',
      platform: 'ANDROID',
      webP256dh: null,
      webAuth: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60000),
    };
    registrations.mockResolvedValue([snapshot]);
    (svc as unknown as { messaging: unknown }).messaging = {
      sendEach: vi
        .fn()
        .mockResolvedValue({
          failureCount: 1,
          responses: [
            {
              success: false,
              error: { code: 'messaging/registration-token-not-registered' },
            },
          ],
        }),
    };
    const invalidate = vi
      .spyOn(svc, 'invalidateSubscription')
      .mockResolvedValue();
    await svc.dispatchForMessage([{ userId: 1, threadFeedEndId: 9 }]);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(snapshot);
  });

  it('coalesces for five seconds and rechecks each device session at trailing delivery', async () => {
    vi.useFakeTimers();
    const session = {
      userId: 1,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    };
    registrations.mockResolvedValue(
      [10, 20].map((sessionId) => ({
        userId: 1,
        sessionId,
        ...session,
        token: `https://push/${sessionId}`,
        platform: 'WEB',
        webP256dh: 'p256',
        webAuth: 'auth',
      })),
    );
    try {
      svc.enqueueForMessage([{ userId: 1, threadFeedEndId: 1 }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(sendNotification).toHaveBeenCalledTimes(2);
      svc.enqueueForMessage([{ userId: 1, threadFeedEndId: 2 }]);
      svc.enqueueForMessage([{ userId: 1, threadFeedEndId: 3 }]);
      sse.isSessionOnline.mockImplementation(
        (_userId: number, sessionId: number) => sessionId === 10,
      );
      await vi.advanceTimersByTimeAsync(4999);
      expect(sendNotification).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sendNotification).toHaveBeenCalledTimes(3);
      expect(sendNotification).toHaveBeenLastCalledWith(
        expect.objectContaining({ endpoint: 'https://push/20' }),
        JSON.stringify({ type: 'NEW_MESSAGE', threadFeedEndId: '3' }),
        expect.anything(),
      );
    } finally {
      svc.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('dispatchForMessage emits exactly { type:"NEW_MESSAGE", threadFeedEndId }', async () => {
    registrations.mockResolvedValue([
      {
        userId: 1,
        sessionId: 10,
        token: 'https://fcm/x',
        deviceId: 'browser-a',
        platform: 'WEB',
        webP256dh: 'p256',
        webAuth: 'auth',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
    ]);
    await svc.dispatchForMessage([{ userId: 1, threadFeedEndId: 7 }]);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const data = JSON.parse(sendNotification.mock.calls[0][1]);
    expect(Object.keys(data).sort()).toEqual(['threadFeedEndId', 'type']);
    expect(data).toMatchObject({
      type: 'NEW_MESSAGE',
      threadFeedEndId: '7',
    });
  });

  it('dispatchForMessage deduplicates users without applying a user-wide online filter', async () => {
    registrations.mockResolvedValue([]);
    await svc.dispatchForMessage([
      { userId: 1, threadFeedEndId: 7 },
      { userId: 1, threadFeedEndId: 8 },
    ]);
    expect(registrations).toHaveBeenCalledOnce();
  });

  it('uses each recipient account head and keeps the newest duplicate target', async () => {
    registrations.mockResolvedValue(
      [1, 2].map((userId) => ({
        userId,
        sessionId: userId,
        token: `https://push/${userId}`,
        deviceId: `device-${userId}`,
        platform: 'WEB',
        webP256dh: 'p256',
        webAuth: 'auth',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      })),
    );
    await svc.dispatchForMessage([
      { userId: 1, threadFeedEndId: 9 },
      { userId: 2, threadFeedEndId: 3 },
      { userId: 1, threadFeedEndId: 7 },
    ]);
    expect(
      sendNotification.mock.calls.map(([subscription, payload]) => [
        subscription.endpoint,
        JSON.parse(payload),
      ]),
    ).toEqual([
      ['https://push/1', { type: 'NEW_MESSAGE', threadFeedEndId: '9' }],
      ['https://push/2', { type: 'NEW_MESSAGE', threadFeedEndId: '3' }],
    ]);
  });

  it('does not propagate notification database errors to callers', async () => {
    registrations.mockRejectedValue(new Error('database unavailable'));
    await expect(
      svc.dispatchForMessage([{ userId: 1, threadFeedEndId: 7 }]),
    ).resolves.toBeUndefined();
  });

  it('does not propagate transient Web Push failures to callers', async () => {
    registrations.mockResolvedValue([
      {
        userId: 1,
        sessionId: 10,
        token: 'https://push.invalid/subscription',
        deviceId: 'browser-a',
        platform: 'WEB',
        webP256dh: 'p256',
        webAuth: 'auth',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
    ]);
    sendNotification.mockRejectedValue({
      statusCode: 503,
      message: 'unavailable',
    });
    await expect(
      svc.dispatchForMessage([{ userId: 1, threadFeedEndId: 7 }]),
    ).resolves.toBeUndefined();
  });

  it('skips only the online device session and still sends to another device', async () => {
    sse.isSessionOnline.mockImplementation(
      (_userId: number, sessionId: number) => sessionId === 10,
    );
    registrations.mockResolvedValue([
      {
        userId: 1,
        sessionId: 10,
        token: 'https://push/a',
        deviceId: 'browser-a',
        platform: 'WEB',
        webP256dh: 'p256-a',
        webAuth: 'auth-a',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
      {
        userId: 1,
        sessionId: 11,
        token: 'https://push/b',
        deviceId: 'browser-b',
        platform: 'WEB',
        webP256dh: 'p256-b',
        webAuth: 'auth-b',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
    ]);

    await svc.dispatchForMessage([{ userId: 1, threadFeedEndId: 7 }]);

    expect(sendNotification).toHaveBeenCalledOnce();
    expect(sendNotification.mock.calls[0][0]).toMatchObject({
      endpoint: 'https://push/b',
    });
  });

  it('does not wake a revoked or expired authenticated session', async () => {
    registrations.mockResolvedValue([
      {
        userId: 1,
        sessionId: 10,
        token: 'https://push/revoked',
        platform: 'WEB',
        webP256dh: 'p256-a',
        webAuth: 'auth-a',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(),
      },
      {
        userId: 1,
        sessionId: 11,
        token: 'https://push/expired',
        platform: 'WEB',
        webP256dh: 'p256-b',
        webAuth: 'auth-b',
        expiresAt: new Date(Date.now() - 60_000),
        revokedAt: null,
      },
    ]);

    await svc.dispatchForMessage([{ userId: 1, threadFeedEndId: 7 }]);

    expect(sendNotification).not.toHaveBeenCalled();
    expect(sse.isSessionOnline).not.toHaveBeenCalled();
  });

  it('sends an incoming call only to valid sessions without live SSE', async () => {
    sse.isSessionOnline.mockImplementation(
      (_userId: number, sessionId: number) => sessionId === 10,
    );
    registrations.mockResolvedValue([
      {
        userId: 1,
        sessionId: 10,
        token: 'https://push/online',
        platform: 'WEB',
        webP256dh: 'p256-a',
        webAuth: 'auth-a',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
      {
        userId: 1,
        sessionId: 11,
        token: 'https://push/offline',
        platform: 'WEB',
        webP256dh: 'p256-b',
        webAuth: 'auth-b',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
    ]);

    await svc.dispatchForCall(1, {
      callSid: 'call-1',
      callerUserId: 2,
      callerName: 'Alice',
      callerAvatar: '',
      callerAccount: 'alice',
      callerDomain: 'example.test',
      threadId: 42,
      callType: 'AUDIO',
    });

    expect(sendNotification).toHaveBeenCalledOnce();
    expect(sendNotification.mock.calls[0][0]).toMatchObject({
      endpoint: 'https://push/offline',
    });
  });

  it('sendTestPush emits { type:"ADMIN_TEST", ts, title, body }', async () => {
    registrations.mockResolvedValue([
      {
        id: 5,
        token: 'https://fcm/x',
        webP256dh: 'p256',
        webAuth: 'auth',
      },
    ]);
    const res = await svc.sendTestPush(5, 'Hello', 'World');
    expect(res).toEqual({ ok: true });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const data = JSON.parse(sendNotification.mock.calls[0][1]);
    expect(data).toMatchObject({
      type: 'ADMIN_TEST',
      title: 'Hello',
      body: 'World',
    });
    expect(typeof data.ts).toBe('string');
  });

  it('runs a current-device FCM probe through accepted → device_received', async () => {
    registrations.mockResolvedValue([
      {
        id: 9,
        userId: 5,
        token: 'android-token',
        platform: 'ANDROID',
      },
    ]);
    const send = vi.fn().mockResolvedValue('projects/p/messages/1');
    (svc as unknown as { messaging: { send: typeof send } }).messaging = {
      send,
    };

    const created = await svc.createFcmProbe(5, 'android-token');
    expect(created.stage).toBe('fcm_accepted');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'android-token',
        data: expect.objectContaining({
          type: 'FCM_HEALTH_PROBE',
          probeId: created.probeId,
        }),
      }),
    );

    const acknowledged = svc.acknowledgeFcmProbe(5, created.probeId);
    expect(acknowledged.stage).toBe('device_received');
    expect(acknowledged.latencyMs).toBeGreaterThanOrEqual(0);
    expect(svc.getFcmProbe(5, created.probeId)).toEqual(acknowledged);
  });

  it('enforces the 30-second probe cooldown per user and token', async () => {
    registrations.mockResolvedValue([
      {
        id: 9,
        userId: 5,
        token: 'android-token',
        platform: 'ANDROID',
      },
    ]);
    const send = vi.fn().mockResolvedValue('projects/p/messages/1');
    (svc as unknown as { messaging: { send: typeof send } }).messaging = {
      send,
    };

    await svc.createFcmProbe(5, 'android-token');
    await expect(svc.createFcmProbe(5, 'android-token')).rejects.toMatchObject({
      status: 429,
      data: { retryAfter: 30 },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
