import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';
import { SessionTokenService } from '../src/auth/session-token.service';
import { BusinessCode } from '../src/common/business-code';

/**
 * QR-login e2e — the desktop/web → 2-week sliding session flow confirmed by an already-logged-in phone,
 * exercised through the real HTTP surface + the KV state machine + SessionAuthGuard.
 *
 * The scanning phone's session is seeded DIRECTLY (how the phone authenticated — OTP in production — is
 * outside this spec's unit of test); what is under test is the create → poll → scan → confirm → claim
 * round-trip, the two-step gates, the issue-once claim, and that the issued session is bound to the
 * scanner's account. Users are inserted via Prisma (admin-provisioned model: self-registration is closed).
 */
describe('QR login e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessionTokens: SessionTokenService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    prisma = app.get(PrismaService);
    sessionTokens = app.get(SessionTokenService);
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "LoginCode", "SessionToken", "User" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  /** Seed a user + their already-authenticated (phone) session — the scanner's credential. */
  async function seedScanner(account: string): Promise<{ userId: number; token: string }> {
    const u = await prisma.user.create({
      data: { account, domain: 'local', name: account, hashPwd: null, mustChangePassword: false, isForeigner: false },
      select: { id: true },
    });
    const token = await sessionTokens.issue(u.id, 'app', { ip: '127.0.0.1', persistent: true });
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
      (await request(app.getHttpServer()).post('/api/v1/auth/qr/poll').send({ qrToken })).body.data
        .status,
    ).toBe('pending');

    const scan = await request(app.getHttpServer())
      .post('/api/v1/auth/qr/scan')
      .set('Authorization', `Bearer ${scannerToken}`)
      .send({ qrToken });
    expect(scan.body.code).toBe(0);

    expect(
      (await request(app.getHttpServer()).post('/api/v1/auth/qr/poll').send({ qrToken })).body.data
        .status,
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

  it('a trusted desktop QR issues a permanent session; web ignores trusted (stays sliding)', async () => {
    const { userId, token: scannerToken } = await seedScanner('qrtrusted');

    // Trusted desktop: create with trusted → scan → confirm → poll claims a permanent session.
    const created = await request(app.getHttpServer())
      .post('/api/v1/auth/qr/create')
      .send({ client: 'desktop', trusted: true });
    const qrToken: string = created.body.data.qrToken;
    await request(app.getHttpServer())
      .post('/api/v1/auth/qr/scan')
      .set('Authorization', `Bearer ${scannerToken}`)
      .send({ qrToken });
    await request(app.getHttpServer())
      .post('/api/v1/auth/qr/confirm')
      .set('Authorization', `Bearer ${scannerToken}`)
      .send({ qrToken });
    const claimed = await request(app.getHttpServer()).post('/api/v1/auth/qr/poll').send({ qrToken });
    expect(claimed.body.data.status).toBe('confirmed');
    const desktopToken: string = claimed.body.data.session_token;

    // The issued desktop session is trusted + permanent (expiresAt null), bound to the scanner.
    const desktopId = await sessionTokens.idOfToken(desktopToken);
    const desktopRow = await prisma.sessionToken.findUnique({
      where: { id: desktopId! },
      select: { client: true, trusted: true, expiresAt: true, userId: true },
    });
    expect(desktopRow).toMatchObject({ client: 'desktop', trusted: true, expiresAt: null, userId });

    // Web can't be trusted: trusted:true is silently ignored for client 'web' → untrusted, sliding 14d.
    const webQr = (
      await request(app.getHttpServer()).post('/api/v1/auth/qr/create').send({ client: 'web', trusted: true })
    ).body.data.qrToken;
    await request(app.getHttpServer()).post('/api/v1/auth/qr/scan').set('Authorization', `Bearer ${scannerToken}`).send({ qrToken: webQr });
    await request(app.getHttpServer()).post('/api/v1/auth/qr/confirm').set('Authorization', `Bearer ${scannerToken}`).send({ qrToken: webQr });
    const webToken = (await request(app.getHttpServer()).post('/api/v1/auth/qr/poll').send({ qrToken: webQr })).body.data.session_token;
    const webRow = await prisma.sessionToken.findUnique({
      where: { id: (await sessionTokens.idOfToken(webToken))! },
      select: { client: true, trusted: true, expiresAt: true },
    });
    expect(webRow).toMatchObject({ client: 'web', trusted: false });
    expect(webRow!.expiresAt).not.toBeNull();
  });

  it('scan requires an authenticated session (the phone is already logged in)', async () => {
    const qrToken = (
      await request(app.getHttpServer()).post('/api/v1/auth/qr/create').send({ client: 'web' })
    ).body.data.qrToken;
    const noAuth = await request(app.getHttpServer())
      .post('/api/v1/auth/qr/scan')
      .send({ qrToken }); // no Bearer → global SessionAuthGuard rejects
    expect(noAuth.status).toBe(401);
  });

  it('confirm without a prior scan is rejected (two-step gate) → QR_INVALID', async () => {
    const { token: scannerToken } = await seedScanner('qrtwostep');
    const qrToken = (
      await request(app.getHttpServer()).post('/api/v1/auth/qr/create').send({ client: 'web' })
    ).body.data.qrToken;
    const confirm = await request(app.getHttpServer())
      .post('/api/v1/auth/qr/confirm')
      .set('Authorization', `Bearer ${scannerToken}`)
      .send({ qrToken }); // pending token, never scanned
    expect(confirm.body.code).toBe(BusinessCode.QR_INVALID);
  });
});
