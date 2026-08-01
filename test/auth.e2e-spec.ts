import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service';
import { user } from '../src/database/schema';
import { BusinessCode } from '../src/common/business-code';
import { seedUser, seedSession } from './seed';

/**
 * Session-management e2e — the device-list / revoke / logout-all surface, exercised through the real HTTP
 * layer + the SessionAuthGuard + the issue-initialized validation cache.
 *
 * The login-method flows themselves (OTP replace, QR two-step) live in otp-login.e2e-spec.ts /
 * qr-login.e2e-spec.ts. This spec seeds sessions DIRECTLY (registration is closed and password login is
 * disabled under APP_OTP_AND_QR) and pins: the device list + isCurrent flag, single-session revoke +
 * ownership check, logout-all revocation (and the KV-cache-lag reality it depends on), and the two
 * policy gates that close the legacy flows — self-registration and password login.
 */
describe('Session management + login-policy e2e', () => {
  let app: INestApplication;
  let database: DatabaseService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
  });

  beforeEach(async () => {
    // CASCADE on User also clears SessionToken (FK→User); both listed so a stray session can't leak
    // between tests even if the on-delete weren't CASCADE.
    await database.pool.query(
      'TRUNCATE TABLE "SessionToken", "User" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /auth/sessions lists the device list and flags the requesting session isCurrent', async () => {
    const { id: userId } = await seedUser(app, 'devtest');
    const aSession = await seedSession(app, userId, 'app', { device: 'Pixel' });
    await seedSession(app, userId, 'web', { device: 'Chrome' });

    const list = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${aSession}`);
    expect(list.body.code).toBe(0);
    const rows = list.body.data;
    expect(rows).toHaveLength(2);
    const current = rows.find((r: { isCurrent: boolean }) => r.isCurrent);
    expect(current).toBeTruthy();
    expect(current.client).toBe('app'); // the requesting credential's row
    expect(current.device).toBe('Pixel');
    expect(
      rows.filter((r: { isCurrent: boolean }) => r.isCurrent),
    ).toHaveLength(1);
  });

  it('POST /auth/revoke-session revokes the targeted session (it then 401s; others survive)', async () => {
    const { id: userId } = await seedUser(app, 'revbyid');
    const aSession = await seedSession(app, userId, 'app');
    const bSession = await seedSession(app, userId, 'web');

    // Find B's row id via the list authed as A (B is the non-current row).
    const list = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${aSession}`);
    const bRow = list.body.data.find(
      (r: { isCurrent: boolean }) => !r.isCurrent,
    );
    expect(bRow).toBeTruthy();

    const revoke = await request(app.getHttpServer())
      .post('/api/v1/auth/revoke-session')
      .set('Authorization', `Bearer ${aSession}`)
      .send({ id: bRow.id });
    expect(revoke.body.code).toBe(0);

    // B is revoked → 401. revokeById drops its persistent validation entry immediately.
    const afterB = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${bSession}`);
    expect(afterB.status).toBe(401);

    // A (the revoker) is unaffected.
    const afterA = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${aSession}`);
    expect(afterA.body.code).toBe(0);
  });

  it("POST /auth/revoke-session is a no-op for another user's session id (ownership-checked)", async () => {
    const owner = await seedUser(app, 'owner');
    const intruder = await seedUser(app, 'intruder');
    const ownerSession = await seedSession(app, owner.id, 'app');
    const intruderSession = await seedSession(app, intruder.id, 'app');

    // Owner's row id (intruder cannot see it; model the threat: the id leaks/guessed).
    const ownerList = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${ownerSession}`);
    const ownerRowId = ownerList.body.data[0].id;

    // Intruder attempts to revoke owner's session → ownership check rejects it (idempotent no-op).
    const revoke = await request(app.getHttpServer())
      .post('/api/v1/auth/revoke-session')
      .set('Authorization', `Bearer ${intruderSession}`)
      .send({ id: ownerRowId });
    expect(revoke.body.code).toBe(0);

    // Owner's session still works.
    const ownerAfter = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${ownerSession}`);
    expect(ownerAfter.body.code).toBe(0);
  });

  it('revokes every cached session on logout-all', async () => {
    const { id: userId } = await seedUser(app, 'revoketest');
    // issue() initializes both validation entries. logout-all must delete both, including tokenB,
    // which is not the credential authorizing the operation.
    const tokenA = await seedSession(app, userId, 'app');
    const tokenB = await seedSession(app, userId, 'app');

    const logoutAll = await request(app.getHttpServer())
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(logoutAll.body.code).toBe(0);

    const guarded = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(guarded.status).toBe(401);
  });

  it('rejects self-registration with REGISTRATION_DISABLED (registration is closed)', async () => {
    const r = await request(app.getHttpServer())
      .post('/api/v1/user/register')
      .send({ account: 'shouldnotexist', name: 'X', password: 'Pass1234' });
    expect(r.body.code).toBe(BusinessCode.REGISTRATION_DISABLED);
    // No user was created.
    const [exists] = await database.db
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.account, 'shouldnotexist'), eq(user.domain, 'local')))
      .limit(1);
    expect(exists).toBeUndefined();
  });

  it('rejects password login with LOGIN_METHOD_DISABLED under APP_OTP_AND_QR', async () => {
    // Seed a user WITH a password so the only thing that can fail is the mode gate (not PASSWORD_NOT_SET).
    await seedUser(app, 'pwuser', { password: 'Pass1234' });
    const r = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ account: 'pwuser', password: 'Pass1234' });
    expect(r.body.code).toBe(BusinessCode.LOGIN_METHOD_DISABLED);
  });
});
