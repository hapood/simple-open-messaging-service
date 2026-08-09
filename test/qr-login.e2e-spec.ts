import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/database/database.service';
import { sessionToken, user } from '../src/database/schema';
import { SessionTokenService } from '../src/auth/session-token.service';
import { BusinessCode } from '../src/common/business-code';

/**
 * QR-login e2e — the desktop/web → 2-week sliding session flow confirmed by an already-logged-in phone,
 * exercised through the real HTTP surface + the KV state machine + SessionAuthGuard.
 *
 * The scanning phone's session is seeded DIRECTLY (how the phone authenticated — OTP in production — is
 * outside this spec's unit of test); what is under test is the create → poll → scan → confirm → claim
 * round-trip, the two-step gates, the issue-once claim, and that the issued session is bound to the
 * scanner's account. Users are inserted via Drizzle (admin-provisioned model: self-registration is closed).
 */
describe('QR login e2e', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let sessionTokens: SessionTokenService;

  beforeAll(async () => {
    // Rate-limit behavior has dedicated coverage. This suite intentionally
    // polls and recreates QR sessions from one loopback address, so isolate the
    // state-machine assertions from production-sized in-memory buckets.
    process.env.RATE_LIMIT_AUTH_QR_CREATE_MODE = 'disabled';
    process.env.RATE_LIMIT_AUTH_QR_POLL_MODE = 'disabled';
    process.env.RATE_LIMIT_AUTH_QR_SCAN_MODE = 'disabled';
    process.env.RATE_LIMIT_AUTH_QR_CONFIRM_MODE = 'disabled';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
    sessionTokens = app.get(SessionTokenService);
  });

  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "LoginCode", "SessionToken", "User" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  /** Seed a user + their already-authenticated (phone) session — the scanner's credential. */
  async function seedScanner(
    account: string,
  ): Promise<{ userId: number; token: string }> {
    const [u] = await database.db
      .insert(user)
      .values({
        account,
        domain: 'local',
        name: account,
        hashPwd: null,
        mustChangePassword: false,
        isForeigner: false,
        updatedAt: new Date(),
      })
      .returning({ id: user.id });
    const token = await sessionTokens.issue(u.id, 'app', {
      ip: '127.0.0.1',
      persistent: true,
    });
    return { userId: u.id, token };
  }

  it('create → pending; scan → scanned; confirm → confirmed + a session bound to the scanner; issue-once', async () => {
    const { token: scannerToken } = await seedScanner('qrscanner');

    const created = await request(app.getHttpServer())
      .post('/api/v1/auth/qr/create')
      .send({ client: 'web' });
    expect(created.body.code).toBe(0);
    const qrToken: string = created.body.data.qrToken;
    expect(qrToken).toBeTruthy();

    expect(
      (
        await request(app.getHttpServer())
          .post('/api/v1/auth/qr/poll')
          .send({ qrToken })
      ).body.data.status,
    ).toBe('pending');

    const scan = await request(app.getHttpServer())
      .post('/api/v1/auth/qr/scan')
      .set('Authorization', `Bearer ${scannerToken}`)
      .send({ qrToken });
    expect(scan.body.code).toBe(0);

    expect(
      (
        await request(app.getHttpServer())
          .post('/api/v1/auth/qr/poll')
          .send({ qrToken })
      ).body.data.status,
    ).toBe('scanned');

    const confirm = await request(app.getHttpServer())
      .post('/api/v1/auth/qr/confirm')
      .set('Authorization', `Bearer ${scannerToken}`)
      .send({ qrToken });
    expect(confirm.body.code).toBe(0);

    const claimed = await request(app.getHttpServer())
      .post('/api/v1/auth/qr/poll')
      .send({ qrToken });
    expect(claimed.body.data.status).toBe('confirmed');
    const desktopToken: string = claimed.body.data.session_token;
    expect(desktopToken).toBeTruthy();

    // The issued session authenticates AND is bound to the SCANNER's account: listing sessions as the
    // desktop token returns that user's sessions — their seeded `app` session + this new `web` one.
    const sessions = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${desktopToken}`);
    expect(sessions.body.code).toBe(0);
    expect(sessions.body.data).toHaveLength(2);
    expect(sessions.body.data.map((s: { client: string }) => s.client)).toEqual(
      expect.arrayContaining(['app', 'web']),
    );

    // Issue-once: a second poll after the claim finds the KV key already removed → expired.
    const again = await request(app.getHttpServer())
      .post('/api/v1/auth/qr/poll')
      .send({ qrToken });
    expect(again.body.data.status).toBe('expired');
  });

  it('desktop and web QR sessions retain their platform and use sliding expiry', async () => {
    const { userId, token: scannerToken } = await seedScanner('qrtrusted');

    // Desktop: create → scan → confirm → poll claims a sliding session.
    const created = await request(app.getHttpServer())
      .post('/api/v1/auth/qr/create')
      .send({ client: 'desktop' });
    const qrToken: string = created.body.data.qrToken;
    await request(app.getHttpServer())
      .post('/api/v1/auth/qr/scan')
      .set('Authorization', `Bearer ${scannerToken}`)
      .send({ qrToken });
    await request(app.getHttpServer())
      .post('/api/v1/auth/qr/confirm')
      .set('Authorization', `Bearer ${scannerToken}`)
      .send({ qrToken });
    const claimed = await request(app.getHttpServer())
      .post('/api/v1/auth/qr/poll')
      .send({ qrToken });
    expect(claimed.body.data.status).toBe('confirmed');
    const desktopToken: string = claimed.body.data.session_token;

    // The issued desktop session is bound to the scanner and has a sliding expiry.
    const desktopId = await sessionTokens.idOfToken(desktopToken);
    const [desktopRow] = await database.db
      .select({
        client: sessionToken.client,
        expiresAt: sessionToken.expiresAt,
        userId: sessionToken.userId,
      })
      .from(sessionToken)
      .where(eq(sessionToken.id, desktopId!))
      .limit(1);
    expect(desktopRow).toMatchObject({
      client: 'desktop',
      userId,
    });
    expect(desktopRow!.expiresAt).not.toBeNull();

    // Web follows the same lifetime policy while retaining its own platform label.
    const webQr = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/qr/create')
        .send({ client: 'web' })
    ).body.data.qrToken;
    await request(app.getHttpServer())
      .post('/api/v1/auth/qr/scan')
      .set('Authorization', `Bearer ${scannerToken}`)
      .send({ qrToken: webQr });
    await request(app.getHttpServer())
      .post('/api/v1/auth/qr/confirm')
      .set('Authorization', `Bearer ${scannerToken}`)
      .send({ qrToken: webQr });
    const webToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/qr/poll')
        .send({ qrToken: webQr })
    ).body.data.session_token;
    const [webRow] = await database.db
      .select({
        client: sessionToken.client,
        expiresAt: sessionToken.expiresAt,
      })
      .from(sessionToken)
      .where(eq(sessionToken.id, (await sessionTokens.idOfToken(webToken))!))
      .limit(1);
    expect(webRow).toMatchObject({ client: 'web' });
    expect(webRow!.expiresAt).not.toBeNull();
  });

  it("an 'app' (Android) QR issues a sliding session bound to the scanner", async () => {
    const { userId, token: scannerToken } = await seedScanner('qrapp');

    // Client kind is metadata only; Android follows the same sliding lifetime.
    const created = await request(app.getHttpServer())
      .post('/api/v1/auth/qr/create')
      .send({ client: 'app' });
    const qrToken: string = created.body.data.qrToken;
    await request(app.getHttpServer())
      .post('/api/v1/auth/qr/scan')
      .set('Authorization', `Bearer ${scannerToken}`)
      .send({ qrToken });
    await request(app.getHttpServer())
      .post('/api/v1/auth/qr/confirm')
      .set('Authorization', `Bearer ${scannerToken}`)
      .send({ qrToken });
    const claimed = await request(app.getHttpServer())
      .post('/api/v1/auth/qr/poll')
      .send({ qrToken });
    expect(claimed.body.data.status).toBe('confirmed');
    const appToken: string = claimed.body.data.session_token;

    const [appRow] = await database.db
      .select({
        client: sessionToken.client,
        expiresAt: sessionToken.expiresAt,
        userId: sessionToken.userId,
      })
      .from(sessionToken)
      .where(eq(sessionToken.id, (await sessionTokens.idOfToken(appToken))!))
      .limit(1);
    expect(appRow).toMatchObject({
      client: 'app',
      userId,
    });
    expect(appRow!.expiresAt).not.toBeNull();
  });

  it('scan requires an authenticated session (the phone is already logged in)', async () => {
    const qrToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/qr/create')
        .send({ client: 'web' })
    ).body.data.qrToken;
    const noAuth = await request(app.getHttpServer())
      .post('/api/v1/auth/qr/scan')
      .send({ qrToken }); // no Bearer → global SessionAuthGuard rejects
    expect(noAuth.status).toBe(401);
  });

  it('confirm without a prior scan is rejected (two-step gate) → QR_INVALID', async () => {
    const { token: scannerToken } = await seedScanner('qrtwostep');
    const qrToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/qr/create')
        .send({ client: 'web' })
    ).body.data.qrToken;
    const confirm = await request(app.getHttpServer())
      .post('/api/v1/auth/qr/confirm')
      .set('Authorization', `Bearer ${scannerToken}`)
      .send({ qrToken }); // pending token, never scanned
    expect(confirm.body.code).toBe(BusinessCode.QR_INVALID);
  });
});
