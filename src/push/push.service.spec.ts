import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the web-push lib so we can assert the exact payload sendNotification receives. vi.hoisted keeps
// the spy reference stable across vitest's mock-factory hoisting.
const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn() }));
vi.mock('web-push', () => ({ default: { sendNotification } }));

import type { SQL } from 'drizzle-orm';
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
  let registrations: ReturnType<typeof vi.fn> &
    ((where?: SQL) => Promise<any[]>);
  let settings: {
    isWebPushConfigured: boolean;
    getVapid: ReturnType<typeof vi.fn>;
  };
  let sse: {
    isSessionOnline: ReturnType<typeof vi.fn>;
    confirmedThreadHead: ReturnType<typeof vi.fn>;
  };
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
    sse = {
      isSessionOnline: vi.fn(() => false),
      confirmedThreadHead: vi.fn(() => -1),
    };
    svc = new PushService(
      {
        db: {},
      } as never,
      sse as never,
      settings as never,
      '/definitely-not-present/soms-firebase-service-account.json',
    );
    svc['registrations'] = registrations;
    svc['hasUnreadForMessagePush'] = vi.fn().mockResolvedValue(true);
  });

  it('holds independent device wakes for five seconds and coalesces the newest head', async () => {
    vi.useFakeTimers();
    try {
      registrations.mockResolvedValue(
        [10, 20].map((sessionId) => ({
          userId: 1,
          sessionId,
          token: `https://push/${sessionId}`,
          platform: 'WEB',
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
        })),
      );
      const dispatch = vi.spyOn(svc, 'dispatchForMessage').mockResolvedValue();
      await svc.enqueueForMessage([{ userId: 1, threadFeedEndId: 1 }]);
      await vi.advanceTimersByTimeAsync(1_000);
      await svc.enqueueForMessage([{ userId: 1, threadFeedEndId: 3 }]);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(dispatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(
        dispatch.mock.calls.map(([targets, sessionId]) => [targets, sessionId]),
      ).toEqual([
        [[{ userId: 1, threadFeedEndId: 3 }], 10],
        [[{ userId: 1, threadFeedEndId: 3 }], 20],
      ]);
    } finally {
      svc.onModuleDestroy();
      vi.useRealTimers();
    }
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
      sendEach: vi.fn().mockResolvedValue({
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

  it('rechecks each device session when its in-memory round becomes due', async () => {
    const session = {
      userId: 1,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    };
    registrations.mockResolvedValue(
      [10, 20].map((sessionId) => ({
        ...session,
        sessionId,
        token: `https://push/${sessionId}`,
        platform: 'WEB',
        webP256dh: 'p256',
        webAuth: 'auth',
      })),
    );
    sse.isSessionOnline.mockImplementation(
      (_userId: number, sessionId: number) => sessionId === 10,
    );
    sse.confirmedThreadHead.mockImplementation(
      (_userId: number, sessionId: number) => (sessionId === 10 ? 3 : -1),
    );
    await svc.dispatchForMessage([{ userId: 1, threadFeedEndId: 3 }]);
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(sendNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ endpoint: 'https://push/20' }),
      JSON.stringify({ type: 'NEW_MESSAGE', threadFeedEndId: '3' }),
      expect.anything(),
    );
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

  it('reports a registration lookup failure without suppressing later rounds', async () => {
    registrations.mockRejectedValue(new Error('database unavailable'));
    await expect(
      svc.dispatchForMessage([{ userId: 1, threadFeedEndId: 7 }]),
    ).rejects.toThrow('database unavailable');
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

  it('skips only the confirmed online device session and still sends to another device', async () => {
    sse.confirmedThreadHead.mockImplementation(
      (_userId: number, sessionId: number) => (sessionId === 10 ? 7 : -1),
    );
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

  it('does not push a confirmed head even when its SSE socket has since disconnected', async () => {
    sse.confirmedThreadHead.mockReturnValue(7);
    registrations.mockResolvedValue([
      {
        userId: 1,
        sessionId: 10,
        token: 'https://push/confirmed',
        platform: 'WEB',
        webP256dh: 'p256',
        webAuth: 'auth',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
    ]);
    await svc.dispatchForMessage([{ userId: 1, threadFeedEndId: 7 }]);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('falls back at the five-second decision when the live SSE has not confirmed the target head', async () => {
    sse.confirmedThreadHead.mockReturnValue(6);
    sse.isSessionOnline.mockReturnValue(true);
    registrations.mockResolvedValue([
      {
        userId: 1,
        sessionId: 10,
        token: 'https://push/unconfirmed',
        platform: 'WEB',
        webP256dh: 'p256',
        webAuth: 'auth',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
    ]);
    await svc.dispatchForMessage([{ userId: 1, threadFeedEndId: 7 }]);
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(JSON.parse(sendNotification.mock.calls[0][1]).threadFeedEndId).toBe(
      '7',
    );
  });

  it('does not fallback-push an online unconfirmed session after its unread attention cleared', async () => {
    sse.isSessionOnline.mockReturnValue(true);
    svc['hasUnreadForMessagePush'] = vi.fn().mockResolvedValue(false);
    registrations.mockResolvedValue([
      {
        userId: 1,
        sessionId: 10,
        token: 'https://push/already-read',
        platform: 'WEB',
        webP256dh: 'p256',
        webAuth: 'auth',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      },
    ]);
    await svc.dispatchForMessage([{ userId: 1, threadFeedEndId: 7 }]);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(svc['hasUnreadForMessagePush']).toHaveBeenCalledExactlyOnceWith(1);
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

    const created = await svc.createPushProbe(5, 9);
    expect(created.stage).toBe('provider_accepted');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'android-token',
        data: expect.objectContaining({
          type: 'PUSH_HEALTH_PROBE',
          probeId: created.probeId,
        }),
      }),
    );

    const acknowledged = svc.acknowledgePushProbe(5, 9, created.probeId);
    expect(acknowledged.stage).toBe('device_received');
    expect(acknowledged.latencyMs).toBeGreaterThanOrEqual(0);
    expect(svc.getPushProbe(5, 9, created.probeId)).toEqual(acknowledged);
  });

  it('enforces the 30-second probe cooldown per session', async () => {
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

    await svc.createPushProbe(5, 9);
    await expect(svc.createPushProbe(5, 9)).rejects.toMatchObject({
      status: 429,
      data: { retryAfter: 30 },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('probes a Web session even while SSE is online and keeps receipts session-scoped', async () => {
    registrations.mockResolvedValue([
      {
        token: 'https://push/web',
        platform: 'WEB',
        webP256dh: 'key',
        webAuth: 'auth',
      },
    ]);
    sse.isSessionOnline.mockReturnValue(true);
    const created = await svc.createPushProbe(5, 9);
    expect(created.stage).toBe('provider_accepted');
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: 'https://push/web', keys: { p256dh: 'key', auth: 'auth' } },
      expect.any(String),
      expect.objectContaining({ TTL: 30 }),
    );
    expect(JSON.parse(sendNotification.mock.calls[0][1])).toMatchObject({
      type: 'PUSH_HEALTH_PROBE',
      probeId: created.probeId,
    });
    expect(() => svc.getPushProbe(5, 10, created.probeId)).toThrow();
    expect(() => svc.acknowledgePushProbe(5, 10, created.probeId)).toThrow();
    expect(() => svc.acknowledgePushProbe(6, 9, created.probeId)).toThrow();
    const received = svc.acknowledgePushProbe(5, 9, created.probeId);
    expect(received.stage).toBe('device_received');
    expect(svc.acknowledgePushProbe(5, 9, created.probeId)).toEqual(received);
    expect(received).not.toHaveProperty('sessionId');
  });

  it('preserves receipt arriving before provider acceptance and coalesces concurrent clicks', async () => {
    registrations.mockResolvedValue([
      {
        token: 'https://push/web',
        platform: 'WEB',
        webP256dh: 'key',
        webAuth: 'auth',
      },
    ]);
    sendNotification.mockImplementation(async (_sub, payload) => {
      svc.acknowledgePushProbe(5, 9, JSON.parse(payload).probeId);
    });
    const results = await Promise.allSettled([
      svc.createPushProbe(5, 9),
      svc.createPushProbe(5, 9),
    ]);
    expect(results[0]).toMatchObject({
      status: 'fulfilled',
      value: { stage: 'device_received' },
    });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { status: 429 },
    });
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it.each([404, 410, 503])(
    'handles Web probe HTTP %s through existing recovery',
    async (statusCode) => {
      const row = {
        userId: 5,
        sessionId: 9,
        pushSubscriptionRev: 1,
        token: 'https://push/web',
        platform: 'WEB',
        webP256dh: 'key',
        webAuth: 'auth',
      };
      registrations.mockResolvedValue([row]);
      sendNotification.mockRejectedValue({ statusCode });
      const invalidate = vi
        .spyOn(svc, 'invalidateSubscription')
        .mockResolvedValue();
      const result = await svc.createPushProbe(5, 9);
      expect(result.stage).toBe('failed');
      if (statusCode === 503) expect(invalidate).not.toHaveBeenCalled();
      else expect(invalidate).toHaveBeenCalledExactlyOnceWith(row);
    },
  );

  it('reports disabled Web Push without claiming provider acceptance', async () => {
    registrations.mockResolvedValue([
      { platform: 'WEB', token: 'https://push/web' },
    ]);
    settings.isWebPushConfigured = false;
    expect(await svc.createPushProbe(5, 9)).toMatchObject({
      stage: 'failed',
      errorCode: 'WEB_PUSH_NOT_CONFIGURED',
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
