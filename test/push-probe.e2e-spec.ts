import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { sessionToken } from '../src/database/schema.js';
import { DatabaseService } from '../src/database/database.service.js';
import { PushService } from '../src/push/push.service.js';
import { SettingsService } from '../src/settings/settings.service.js';
import { seedUser, seedSession } from './seed.js';
import { createTestApp } from './support/app.js';

const { sendNotification } = vi.hoisted(() => ({
  sendNotification: vi.fn().mockResolvedValue({}),
}));
vi.mock('web-push', async (importOriginal) => {
  const actual = await importOriginal<typeof import('web-push')>();
  return { ...actual, default: { ...actual.default, sendNotification } };
});

describe('Session-scoped push probe HTTP flow', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  beforeAll(async () => {
    ({ app, database } = await createTestApp());
  });
  afterAll(async () => {
    await app?.close();
  });

  it('selects only the authenticated session and rejects other-session receipts', async () => {
    const user = await seedUser(app, 'probe-' + Date.now());
    const credential = await seedSession(app, user.id, 'web');
    const other = await seedSession(app, user.id, 'web');
    const [session] = await database.db
      .select()
      .from(sessionToken)
      .where(
        eq(
          sessionToken.tokenHash,
          createHash('sha256').update(credential).digest('hex'),
        ),
      );
    await app.get(PushService).registerToken(user.id, session.id, {
      sessionId: session.id,
      pushSubscriptionRev: 1,
      platform: 'WEB',
      token: 'https://push.test/' + session.id,
      p256dh: 'key',
      auth: 'auth',
    });
    const settings = app.get(SettingsService);
    const configured = vi
      .spyOn(settings, 'isWebPushConfigured', 'get')
      .mockReturnValue(true);
    const vapid = vi.spyOn(settings, 'getVapid').mockReturnValue({
      subject: 'mailto:test@example.com',
      publicKey: 'pk',
      privateKey: 'sk',
    });
    try {
      await request(app.getHttpServer())
        .post('/api/v1/devices/push-probes')
        .send({})
        .expect(401);
      const created = await request(app.getHttpServer())
        .post('/api/v1/devices/push-probes')
        .set('Authorization', `Bearer ${credential}`)
        .send({})
        .expect(200);
      expect(created.body.code).toBe(0);
      expect(created.body.data.stage).toBe('provider_accepted');
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(sendNotification.mock.calls[0][0].endpoint).toBe(
        'https://push.test/' + session.id,
      );
      const path = '/api/v1/devices/push-probes/' + created.body.data.probeId;
      const wrongRead = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${other}`);
      expect(wrongRead.body.code).not.toBe(0);
      const wrongAck = await request(app.getHttpServer())
        .post(path + '/ack')
        .set('Authorization', `Bearer ${other}`)
        .send({});
      expect(wrongAck.body.code).not.toBe(0);
      const ack = await request(app.getHttpServer())
        .post(path + '/ack')
        .set('Authorization', `Bearer ${credential}`)
        .send({})
        .expect(200);
      expect(ack.body.data.stage).toBe('device_received');
      const status = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${credential}`)
        .expect(200);
      expect(status.body.data).toEqual(ack.body.data);
      const unregistered = await request(app.getHttpServer())
        .post('/api/v1/devices/push-probes')
        .set('Authorization', `Bearer ${other}`)
        .send({});
      expect(unregistered.body.code).not.toBe(0);
      expect(sendNotification).toHaveBeenCalledTimes(1);
    } finally {
      configured.mockRestore();
      vapid.mockRestore();
    }
  });
});
