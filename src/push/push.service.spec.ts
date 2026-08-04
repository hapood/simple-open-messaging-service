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
 * FCM is disabled in the test env (GOOGLE_APPLICATION_CREDENTIALS unset → messaging=null), so these
 * cases exercise the Web Push branch — the payload is identical across transports (FCM data = the same
 * flat string map; Web Push = its JSON.stringify).
 */
describe('PushService — identity-only payloads', () => {
  let svc: PushService;
  let pushToken: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  let settings: {
    isWebPushConfigured: boolean;
    getVapid: ReturnType<typeof vi.fn>;
  };
  let sse: { isUserOnline: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    sendNotification.mockReset();
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS; // FCM disabled → exercise the Web Push branch
    pushToken = { findMany: vi.fn(), findFirst: vi.fn() };
    settings = {
      isWebPushConfigured: true,
      getVapid: vi.fn(() => ({
        subject: 'mailto:t@t',
        publicKey: 'pk',
        privateKey: 'sk',
      })),
    };
    sse = { isUserOnline: vi.fn(() => false) };
    svc = new PushService(
      { db: { query: { pushToken } } } as never,
      sse as never,
      settings as never,
    );
  });

  it('dispatchForMessage emits exactly { type:"NEW_MESSAGE", ts, threadId, seq } (no body/preview/contentType/msgid)', async () => {
    pushToken.findMany.mockResolvedValue([
      {
        token: 'https://fcm/x',
        platform: 'WEB',
        webP256dh: 'p256',
        webAuth: 'auth',
      },
    ]);
    await svc.dispatchForMessage([{ userId: 1 }], 42, 7);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const data = JSON.parse(sendNotification.mock.calls[0][1]);
    expect(Object.keys(data).sort()).toEqual(['seq', 'threadId', 'ts', 'type']);
    expect(data).toMatchObject({
      type: 'NEW_MESSAGE',
      threadId: '42',
      seq: '7',
    });
    expect(typeof data.ts).toBe('string'); // FCM requires string values; Web Push JSON-stringifies
  });

  it('dispatchForMessage skips recipients with a live SSE connection (no double-delivery)', async () => {
    sse.isUserOnline.mockReturnValue(true);
    await svc.dispatchForMessage([{ userId: 1 }], 42, 7);
    expect(pushToken.findMany).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sendTestPush emits { type:"ADMIN_TEST", ts, title, body }', async () => {
    pushToken.findFirst.mockResolvedValue({
      id: 5,
      token: 'https://fcm/x',
      webP256dh: 'p256',
      webAuth: 'auth',
    });
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
    pushToken.findFirst.mockResolvedValue({
      id: 9,
      userId: 5,
      token: 'android-token',
      platform: 'ANDROID',
    });
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
    pushToken.findFirst.mockResolvedValue({
      id: 9,
      userId: 5,
      token: 'android-token',
      platform: 'ANDROID',
    });
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
