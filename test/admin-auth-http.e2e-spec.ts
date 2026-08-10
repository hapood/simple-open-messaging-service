import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request, { type Response } from 'supertest';
import { Secret, TOTP } from 'otpauth';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/database/database.service';
import { admin } from '../src/database/schema';
import { AdminRole } from '../src/database/enums';
import { TwoFactorService } from '../src/admin/two-factor.service';
import { ADMIN_SESSION_COOKIE } from '../src/admin/admin-session';
import { BusinessCode } from '../src/common/business-code';
import { KvStoreService } from '../src/kv-store/kv-store.service';
import { seedUser } from './seed';

const PASSWORD = 'Admin-http-e2e-password-1!';

function cookieFrom(response: Response): string {
  const header = response.headers['set-cookie'];
  const first = Array.isArray(header) ? header[0] : header;
  if (!first) throw new Error('admin_session cookie was not set');
  return first.split(';', 1)[0];
}

function totpFor(secret: string): string {
  return new TOTP({
    issuer: 'SOMS Admin',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate();
}

describe('Admin authentication HTTP security', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let twoFactor: TwoFactorService;
  let kv: KvStoreService;

  beforeAll(async () => {
    delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
    twoFactor = app.get(TwoFactorService);
    kv = app.get(KvStoreService);
  });

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
    // Each case starts a fresh fixed-window budget. Cover the address spellings Fastify can use for
    // an in-process request without reaching into KvStoreService's private maps.
    await kv.del(
      ...['127.0.0.1', '::1', '::ffff:127.0.0.1', 'unknown'].flatMap((ip) =>
        ['admin/login', 'admin/login/verify'].map(
          (path) => `rl:/api/v1/${path}:${ip}`,
        ),
      ),
    );
  });

  afterAll(async () => app.close());

  async function seedAdmin(account: string): Promise<number> {
    const createdUser = await seedUser(app, account, {
      name: account,
      password: PASSWORD,
    });
    const [createdAdmin] = await database.db
      .insert(admin)
      .values({
        userId: createdUser.id,
        role: AdminRole.SUPER_ADMIN,
        enabled: true,
        updatedAt: new Date(),
      })
      .returning({ id: admin.id });
    return createdAdmin.id;
  }

  const post = (path: string, body: object = {}, cookie?: string) => {
    const call = request(app.getHttpServer())
      .post(`/api/v1/${path}`)
      .send(body);
    return cookie ? call.set('Cookie', cookie) : call;
  };

  it('enrolls TOTP over HTTP, revokes the old session, and completes a challenged login', async () => {
    await seedAdmin('totp-admin');

    const initialLogin = await post('admin/login', {
      account: 'totp-admin',
      password: PASSWORD,
    });
    expect(initialLogin.body.code).toBe(BusinessCode.OK);
    expect(initialLogin.body.data).toEqual({ authenticated: true });
    const oldCookie = cookieFrom(initialLogin);

    const setup = await post('admin/2fa/setup', {}, oldCookie);
    expect(setup.body.code).toBe(BusinessCode.OK);
    expect(setup.body.data).toMatchObject({
      secret: expect.any(String),
      pendingToken: expect.any(String),
      otpauthUri: expect.stringContaining('otpauth://totp/'),
    });

    const enabled = await post(
      'admin/2fa/setup/verify',
      {
        pendingToken: setup.body.data.pendingToken,
        code: totpFor(setup.body.data.secret),
      },
      oldCookie,
    );
    expect(enabled.body.code).toBe(BusinessCode.OK);
    expect(enabled.body.data.backupCodes).toHaveLength(10);

    const oldSession = await post('admin/me', {}, oldCookie);
    expect(oldSession.status).toBe(401);
    expect(oldSession.body.code).toBe(BusinessCode.UNAUTHENTICATED);

    const challenged = await post('admin/login', {
      account: 'totp-admin',
      password: PASSWORD,
    });
    expect(challenged.body.data).toMatchObject({
      twoFactorRequired: true,
      factors: { totp: true, webauthn: false },
    });
    expect(challenged.headers['set-cookie']).toBeUndefined();

    const verified = await post('admin/login/verify', {
      challengeToken: challenged.body.data.challengeToken,
      code: totpFor(setup.body.data.secret),
    });
    expect(verified.body.data).toEqual({ authenticated: true });
    const sessionHeader = String(verified.headers['set-cookie']);
    expect(sessionHeader).toContain(ADMIN_SESSION_COOKIE);
    expect(sessionHeader).toContain('HttpOnly');
    expect(sessionHeader).toContain('SameSite=Strict');

    const me = await post('admin/me', {}, cookieFrom(verified));
    expect(me.body.data).toMatchObject({
      account: 'totp-admin',
      role: AdminRole.SUPER_ADMIN,
    });
  });

  it('accepts a backup code once and rejects reused or invalid challenges', async () => {
    const adminId = await seedAdmin('backup-admin');
    const setup = twoFactor.beginSetup(adminId, 'backup-admin', 'backup-admin');
    const { backupCodes } = await twoFactor.enableWithBackupCodes(
      adminId,
      setup.secret,
    );

    const login = () =>
      post('admin/login', { account: 'backup-admin', password: PASSWORD });

    const firstChallenge = await login();
    const first = await post('admin/login/verify', {
      challengeToken: firstChallenge.body.data.challengeToken,
      backupCode: backupCodes[0],
    });
    expect(first.body.code).toBe(BusinessCode.OK);
    expect(first.body.data).toEqual({ authenticated: true });

    const replayedChallenge = await post('admin/login/verify', {
      challengeToken: firstChallenge.body.data.challengeToken,
      backupCode: backupCodes[1],
    });
    expect(replayedChallenge.body.code).toBe(
      BusinessCode.TWO_FACTOR_CHALLENGE_EXPIRED,
    );
    expect(replayedChallenge.headers['set-cookie']).toBeUndefined();

    const secondChallenge = await login();
    const reused = await post('admin/login/verify', {
      challengeToken: secondChallenge.body.data.challengeToken,
      backupCode: backupCodes[0],
    });
    expect(reused.body.code).toBe(BusinessCode.TWO_FACTOR_INVALID);
    expect(reused.headers['set-cookie']).toBeUndefined();

    const expired = await post('admin/login/verify', {
      challengeToken: 'not-a-valid-jwt',
      code: '123456',
    });
    expect(expired.body.code).toBe(BusinessCode.TWO_FACTOR_CHALLENGE_EXPIRED);
  });

  it('starts WebAuthn registration only after authenticated password re-verification', async () => {
    await seedAdmin('passkey-admin');
    const login = await post('admin/login', {
      account: 'passkey-admin',
      password: PASSWORD,
    });
    const cookie = cookieFrom(login);

    const rejected = await post(
      'admin/webauthn/registration/begin',
      { password: 'wrong-password', nickname: 'Laptop' },
      cookie,
    );
    expect(rejected.body.code).toBe(BusinessCode.INVALID_CREDENTIALS);

    const begin = await post(
      'admin/webauthn/registration/begin',
      { password: PASSWORD, nickname: 'Laptop' },
      cookie,
    );
    expect(begin.body.code).toBe(BusinessCode.OK);
    expect(begin.body.data).toMatchObject({
      pendingToken: expect.any(String),
      options: {
        rp: { id: 'localhost' },
        user: { name: 'passkey-admin' },
        challenge: expect.any(String),
      },
    });
  });

  it('enforces the public login endpoint fixed-window IP ceiling', async () => {
    await seedAdmin('rate-limit-admin');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await post('admin/login', {
        account: 'rate-limit-admin',
        password: 'wrong-password',
      });
      expect(failed.status).toBe(200);
      expect(failed.body.code).toBe(BusinessCode.INVALID_CREDENTIALS);
    }

    const limited = await post('admin/login', {
      account: 'rate-limit-admin',
      password: 'wrong-password',
    });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe(BusinessCode.RATE_LIMITED);
  });
});
