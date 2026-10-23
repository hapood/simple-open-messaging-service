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
import request, { type Response } from 'supertest';
import { Secret, TOTP } from 'otpauth';
import { DatabaseService } from '../src/database/database.service';
import {
  account,
  admin,
  adminSession,
  sessionToken,
} from '../src/database/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { SessionTokenService } from '../src/auth/session-token.service';
import { AdminRole } from '../src/database/enums';
import { TwoFactorService } from '../src/admin/two-factor.service';
import { ADMIN_SESSION_COOKIE } from '../src/admin/admin-session';
import { BusinessCode } from '../src/common/business-code';
import { KvStoreService } from '../src/kv-store/kv-store.service';
import { FixedWindowPolicyService } from '../src/rate-limit/fixed-window-policy.service';
import { seedUser } from './seed';
import { createTestApp } from './support/app';
import { truncateTablesForTest } from './support/truncate';

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
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let twoFactor: TwoFactorService;
  let kv: KvStoreService;
  let fixedWindowPolicies: FixedWindowPolicyService;

  beforeAll(async () => {
    delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    ({ app, database } = await createTestApp());
    twoFactor = app.get(TwoFactorService);
    kv = app.get(KvStoreService);
    fixedWindowPolicies = app.get(FixedWindowPolicyService);
  });

  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread" RESTART IDENTITY CASCADE',
    );
    // Each case starts a fresh fixed-window budget. Cover the address spellings Fastify can use for
    // an in-process request without reaching into KvStoreService's private maps.
    await kv.del(
      ...['127.0.0.1', '::1', '::ffff:127.0.0.1', 'unknown'].flatMap((ip) =>
        (['admin.login', 'admin.login.verify', 'admin.two-factor', 'admin.webauthn'] as const).map(policy => fixedWindowPolicies.bucketKey(policy, ip)),
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

    const setup = await post(
      'admin/2fa/setup',
      { password: PASSWORD },
      oldCookie,
    );
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
      backupCode: enabled.body.data.backupCodes[0],
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

  it('atomically changes the password once, revokes every own session, and leaves another account intact', async () => {
    const id = await seedAdmin('password-admin');
    const otherId = await seedAdmin('other-admin');
    const owner = await database.db.query.admin.findFirst({
      where: eq(admin.id, id),
    });
    const sessions = app.get(SessionTokenService);
    const userToken = await sessions.issue(owner!.userId, 'web');
    const first = cookieFrom(
      await post('admin/login', {
        account: 'password-admin',
        password: PASSWORD,
      }),
    );
    const second = cookieFrom(
      await post('admin/login', {
        account: 'password-admin',
        password: PASSWORD,
      }),
    );
    const other = cookieFrom(
      await post('admin/login', { account: 'other-admin', password: PASSWORD }),
    );
    const current = await post('admin/account/current', {}, first);
    expect(current.body.data.currentIp).toEqual(expect.any(String));
    const list = await post('admin/admin-sessions', {}, first);
    expect(
      list.body.data.list.filter((s: { isCurrent: boolean }) => s.isCurrent),
    ).toHaveLength(1);
    const results = await Promise.all([
      post(
        'admin/account/password',
        { password: PASSWORD, newPassword: 'NewPassword123!' },
        first,
      ),
      post(
        'admin/account/password',
        { password: PASSWORD, newPassword: 'OtherPassword123!' },
        second,
      ),
    ]);
    expect(results.filter((r) => r.body.code === BusinessCode.OK)).toHaveLength(
      1,
    );
    expect((await post('admin/me', {}, first)).status).toBe(401);
    expect((await post('admin/me', {}, second)).status).toBe(401);
    expect((await post('admin/me', {}, other)).body.code).toBe(BusinessCode.OK);
    expect(await sessions.validate(userToken)).toBeNull();
    expect(
      await database.db
        .select()
        .from(adminSession)
        .where(
          and(eq(adminSession.adminId, id), isNull(adminSession.revokedAt)),
        ),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(sessionToken)
        .where(
          and(
            eq(sessionToken.userId, owner!.userId),
            isNull(sessionToken.revokedAt),
          ),
        ),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(adminSession)
        .where(
          and(
            eq(adminSession.adminId, otherId),
            isNull(adminSession.revokedAt),
          ),
        ),
    ).toHaveLength(1);
  });

  it('cannot initialize a stale cache after a concurrent password rotation', async () => {
    const id = await seedAdmin('cache-race-admin');
    const owner = await database.db.query.admin.findFirst({
      where: eq(admin.id, id),
    });
    const cookie = cookieFrom(
      await post('admin/login', {
        account: 'cache-race-admin',
        password: PASSWORD,
      }),
    );
    const sessions = app.get(SessionTokenService);
    let reached!: () => void;
    const initialized = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = kv.initPersistent.bind(kv);
    const spy = vi
      .spyOn(kv, 'initPersistent')
      .mockImplementationOnce(async (...args) => {
        reached();
        await gate;
        await original(...args);
      });
    const issuance = sessions.issue(owner!.userId, 'web');
    try {
      await initialized;
      // The rotation is allowed to start while issuance holds the account lock.
      const rotation = post(
        'admin/account/password',
        { password: PASSWORD, newPassword: 'NewPassword123!' },
        cookie,
      ).then((response) => response);
      release();
      const token = await issuance;
      expect((await rotation).body.code).toBe(BusinessCode.OK);
      expect(await sessions.validate(token)).toBeNull();
      expect(await kv.getPersistent(spy.mock.calls[0][0])).toBeNull();
    } finally {
      release();
      await issuance.catch(() => {});
      spy.mockRestore();
    }
  });

  it('requires an enrolled factor to change passwords and forbids the consumer bypass', async () => {
    const id = await seedAdmin('factor-admin');
    const owner = await database.db.query.admin.findFirst({
      where: eq(admin.id, id),
    });
    const setup = twoFactor.beginSetup(id, 'factor-admin', 'factor-admin');
    const codes = await twoFactor.enableWithBackupCodes(id, setup.secret);
    const challenge = await post('admin/login', {
      account: 'factor-admin',
      password: PASSWORD,
    });
    const login = await post('admin/login/verify', {
      challengeToken: challenge.body.data.challengeToken,
      backupCode: codes.backupCodes[0],
    });
    const cookie = cookieFrom(login);
    const denied = await post(
      'admin/account/password',
      { password: PASSWORD, newPassword: 'NewPassword123!' },
      cookie,
    );
    expect(denied.body.code).toBe(BusinessCode.TWO_FACTOR_INVALID);
    const token = await app
      .get(SessionTokenService)
      .issue(owner!.userId, 'web');
    const bypass = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: PASSWORD, newPassword: 'NewPassword123!' });
    expect(bypass.body.code).toBe(BusinessCode.FORBIDDEN);
    const success = await post(
      'admin/account/password',
      {
        password: PASSWORD,
        newPassword: 'NewPassword123!',
        backupCode: codes.backupCodes[1],
      },
      cookie,
    );
    expect(success.body.code).toBe(BusinessCode.OK);
  });

  it('rejects enrollment without fresh proof and concurrent replay of a setup permit', async () => {
    await seedAdmin('setup-admin');
    const cookie = cookieFrom(
      await post('admin/login', { account: 'setup-admin', password: PASSWORD }),
    );
    expect((await post('admin/2fa/setup', {}, cookie)).body.code).not.toBe(
      BusinessCode.OK,
    );
    const setup = await post('admin/2fa/setup', { password: PASSWORD }, cookie);
    const body = {
      pendingToken: setup.body.data.pendingToken,
      code: totpFor(setup.body.data.secret),
    };
    const results = await Promise.all([
      post('admin/2fa/setup/verify', body, cookie),
      post('admin/2fa/setup/verify', body, cookie),
    ]);
    expect(results.filter((r) => r.body.code === BusinessCode.OK)).toHaveLength(
      1,
    );
  });

  it('rejects an enrollment permit in another session and after password rotation', async () => {
    await seedAdmin('bound-admin');
    const login = () =>
      post('admin/login', { account: 'bound-admin', password: PASSWORD });
    const cookie = cookieFrom(await login());
    const other = cookieFrom(await login());
    const setup = await post('admin/2fa/setup', { password: PASSWORD }, cookie);
    const body = {
      pendingToken: setup.body.data.pendingToken,
      code: totpFor(setup.body.data.secret),
    };
    expect(
      (await post('admin/2fa/setup/verify', body, other)).body.code,
    ).not.toBe(BusinessCode.OK);
    expect(
      (
        await post(
          'admin/account/password',
          { password: PASSWORD, newPassword: 'RotatedPassword1!' },
          cookie,
        )
      ).body.code,
    ).toBe(BusinessCode.OK);
    expect((await post('admin/2fa/setup/verify', body, cookie)).status).toBe(
      401,
    );
  });

  it('allows only one concurrent login to consume the same TOTP time step', async () => {
    const id = await seedAdmin('concurrent-totp');
    const setup = twoFactor.beginSetup(
      id,
      'concurrent-totp',
      'concurrent-totp',
    );
    await twoFactor.enableWithBackupCodes(id, setup.secret);
    const login = () =>
      post('admin/login', { account: 'concurrent-totp', password: PASSWORD });
    const first = await login();
    const second = await login();
    const code = totpFor(setup.secret);
    const results = await Promise.all(
      [first, second].map((challenge) =>
        post('admin/login/verify', {
          challengeToken: challenge.body.data.challengeToken,
          code,
        }),
      ),
    );
    expect(
      results.filter((result) => result.body.code === BusinessCode.OK),
    ).toHaveLength(1);
  });

  it('requires fresh proof to remove passkeys and forbids self-reset through the recovery endpoint', async () => {
    const id = await seedAdmin('remove-admin');
    const cookie = cookieFrom(
      await post('admin/login', {
        account: 'remove-admin',
        password: PASSWORD,
      }),
    );
    expect(
      (await post('admin/webauthn/credentials/1/delete', {}, cookie)).body.code,
    ).not.toBe(BusinessCode.OK);
    expect(
      (await post(`admin/admins/${id}/reset-2fa`, {}, cookie)).status,
    ).toBe(403);
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
