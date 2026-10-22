import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { DatabaseService } from '../src/database/database.service.js';
import { sessionToken } from '../src/database/schema.js';
import { PushService } from '../src/push/push.service.js';
import { SseService } from '../src/gateway/sse.service.js';
import { seedUser, seedSession } from './seed.js';
import { createTestApp } from './support/app.js';

describe('Session push registration generations', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let push: PushService;
  let userId: number;
  let sessionId: number;
  let credential: string;
  beforeAll(async () => {
    ({ app, database } = await createTestApp());
    push = app.get(PushService);
  });
  beforeEach(async () => {
    userId = (
      await seedUser(
        app,
        `push-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      )
    ).id;
    credential = await seedSession(app, userId, 'web');
    const [row] = await database.db
      .select()
      .from(sessionToken)
      .where(
        eq(
          sessionToken.tokenHash,
          createHash('sha256').update(credential).digest('hex'),
        ),
      );
    sessionId = row.id;
  });
  afterAll(async () => {
    await app.close();
  });

  const dto = (id: number, rev: number, token: string) => ({
    sessionId: id,
    pushSubscriptionRev: rev,
    token,
    platform: 'ANDROID' as const,
  });
  const row = async () =>
    (
      await database.db
        .select()
        .from(sessionToken)
        .where(eq(sessionToken.id, sessionId))
    )[0];

  it('starts at 1, rejects the old protocol and accepts only the authenticated session', async () => {
    expect((await row()).pushSubscriptionRev).toBe(1);
    const old = await request(app.getHttpServer())
      .post('/api/v1/devices/register')
      .set('Authorization', `Bearer ${credential}`)
      .send({ token: 'old', platform: 'ANDROID' });
    expect(old.body.code).not.toBe(0);
    await expect(
      push.registerToken(userId, sessionId, dto(sessionId + 1, 1, 'wrong')),
    ).rejects.toThrow();
    expect(
      await push.registerToken(
        userId,
        sessionId,
        dto(sessionId, 1, `token-${sessionId}`),
      ),
    ).toMatchObject({ registered: true, pushSubscriptionRev: 1 });
    expect((await row()).pushToken).toBe(`token-${sessionId}`);
  });

  it('concurrent permanent failures increment once and notify only the changed session', async () => {
    const token = `dead-${sessionId}`;
    await push.registerToken(userId, sessionId, dto(sessionId, 1, token));
    const changed = vi.spyOn(app.get(SseService), 'onPushSubscriptionChanged');
    try {
      const snapshot = { userId, sessionId, token, pushSubscriptionRev: 1 };
      await Promise.all([
        push.invalidateSubscription(snapshot),
        push.invalidateSubscription(snapshot),
      ]);
      expect(await row()).toMatchObject({
        pushSubscriptionRev: 2,
        pushToken: null,
        pushPlatform: null,
        pushP256dh: null,
        pushAuth: null,
      });
      expect(changed).toHaveBeenCalledExactlyOnceWith(userId, sessionId, 2);
      expect(
        await push.registerToken(userId, sessionId, dto(sessionId, 1, token)),
      ).toMatchObject({ registered: false, pushSubscriptionRev: 2 });
      await push.registerToken(
        userId,
        sessionId,
        dto(sessionId, 2, `new-${sessionId}`),
      );
      await push.invalidateSubscription(snapshot);
      expect(await row()).toMatchObject({
        pushSubscriptionRev: 2,
        pushToken: `new-${sessionId}`,
      });
    } finally {
      changed.mockRestore();
    }
  });

  it('a late old-token failure cannot clear an SDK token rotation at the same revision', async () => {
    const token = `before-${sessionId}`;
    await push.registerToken(userId, sessionId, dto(sessionId, 1, token));
    await push.registerToken(
      userId,
      sessionId,
      dto(sessionId, 1, `after-${sessionId}`),
    );
    await push.invalidateSubscription({
      userId,
      sessionId,
      token,
      pushSubscriptionRev: 1,
    });
    expect(await row()).toMatchObject({
      pushSubscriptionRev: 1,
      pushToken: `after-${sessionId}`,
    });
  });

  it('transfers an installation token to a newer login and blocks the old login from stealing it back', async () => {
    const token = `shared-${sessionId}`;
    await push.registerToken(userId, sessionId, dto(sessionId, 1, token));
    const nextCredential = await seedSession(app, userId, 'web');
    const [next] = await database.db
      .select()
      .from(sessionToken)
      .where(
        eq(
          sessionToken.tokenHash,
          createHash('sha256').update(nextCredential).digest('hex'),
        ),
      );
    await push.registerToken(userId, next.id, dto(next.id, 1, token));
    expect((await row()).pushToken).toBeNull();
    await expect(
      push.registerToken(userId, sessionId, dto(sessionId, 1, token)),
    ).rejects.toThrow();
  });
});
