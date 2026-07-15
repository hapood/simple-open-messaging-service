import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';

/**
 * Auth e2e smoke — the regression anchor for the ESM migration.
 *
 * One flow exercises the entire native-interop risk surface:
 *   register (argon2.hash + Prisma write)
 *   -> login (argon2.verify + JwtService) -> access token
 *   -> guarded route (JwtAuthGuard validates the signed token)
 * Must stay green after the CJS->ESM flip and the Express→Fastify adapter swap.
 */
describe('Auth e2e (register -> login -> guarded)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // Plain Fastify adapter (no http2/TLS) configured exactly like production via configureApp.
    // No explicit app.init(): setGlobalPrefix must run before routes are registered, and
    // listen() performs init + route registration + Fastify ready()/preReady (without which
    // route-context lifecycle hooks like preParsing are undefined and the first request crashes).
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    // Isolate every run: truncating User CASCADE-clears RefreshToken,
    // AdminRefreshToken, threads, messages, etc.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "User" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers a user, logs in, and reaches a guarded route', async () => {
    // 1. register (argon2.hash + Prisma)
    const reg = await request(app.getHttpServer())
      .post('/api/v1/user/register')
      .send({ account: 'e2etest', name: 'E2E Test', password: 'Pass1234' });
    expect(reg.status).toBe(200);
    expect(reg.body.code).toBe(0);

    // 2. login (argon2.verify + JwtService) -> access token
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ account: 'e2etest', password: 'Pass1234' });
    expect(login.status).toBe(200);
    expect(login.body.code).toBe(0);
    const accessToken = login.body.data.access_token;
    expect(accessToken).toBeTruthy();

    // 3. guarded route (JwtAuthGuard validates the signed token)
    const guarded = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(guarded.status).toBe(200);
    expect(guarded.body.code).toBe(0);
  });

  it('issues a session token on login that authenticates a guarded route (app + web)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/user/register')
      .send({ account: 'sesstest', name: 'Sess', password: 'Pass1234' })
      .expect((r) => expect(r.body.code).toBe(0));

    // app client → no-expiry session token (Telegram-style).
    const appLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ account: 'sesstest', password: 'Pass1234', client: 'app' });
    const appSession: string | undefined = appLogin.body.data.session_token;
    expect(appSession).toBeTruthy();
    const appGuarded = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${appSession}`);
    expect(appGuarded.status).toBe(200);
    expect(appGuarded.body.code).toBe(0);

    // web client → sliding 30-day session token; same guarded acceptance.
    const webLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ account: 'sesstest', password: 'Pass1234', client: 'web' });
    expect(webLogin.body.data.session_token).toBeTruthy();
    const webGuarded = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${webLogin.body.data.session_token}`);
    expect(webGuarded.body.code).toBe(0);
  });

  it('revokes the session token on logout-all (it then 401s)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/user/register')
      .send({ account: 'revoketest', name: 'Revoke', password: 'Pass1234' })
      .expect((r) => expect(r.body.code).toBe(0));

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ account: 'revoketest', password: 'Pass1234', client: 'app' });
    const accessToken: string = login.body.data.access_token;
    const sessionToken: string = login.body.data.session_token;
    // IMPORTANT: do NOT use the session token before logout-all — that would populate its 60s KV
    // cache and mask the revocation. The first validate after revoke is a cache miss → DB read.
    const logoutAll = await request(app.getHttpServer())
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(logoutAll.body.code).toBe(0);

    const guarded = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(guarded.status).toBe(401);
  });

  it('GET /auth/sessions lists the device list and flags the requesting session isCurrent', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/user/register')
      .send({ account: 'devtest', name: 'Dev', password: 'Pass1234' })
      .expect((r) => expect(r.body.code).toBe(0));

    const a = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ account: 'devtest', password: 'Pass1234', client: 'app', device: 'Pixel' });
    const aSession: string = a.body.data.session_token;
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ account: 'devtest', password: 'Pass1234', client: 'web', device: 'Chrome' });

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
    expect(typeof current.id).toBe('number');
    expect(rows.filter((r: { isCurrent: boolean }) => r.isCurrent)).toHaveLength(1);
  });

  it('POST /auth/revoke-session revokes the targeted session (it then 401s; others survive)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/user/register')
      .send({ account: 'revbyid', name: 'Rev', password: 'Pass1234' })
      .expect((r) => expect(r.body.code).toBe(0));

    const a = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ account: 'revbyid', password: 'Pass1234', client: 'app' });
    const aSession: string = a.body.data.session_token;
    const b = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ account: 'revbyid', password: 'Pass1234', client: 'web' });
    const bSession: string = b.body.data.session_token;

    // Find B's row id via the list authed as A (B is the non-current row).
    const list = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${aSession}`);
    const bRow = list.body.data.find((r: { isCurrent: boolean }) => !r.isCurrent);
    expect(bRow).toBeTruthy();

    const revoke = await request(app.getHttpServer())
      .post('/api/v1/auth/revoke-session')
      .set('Authorization', `Bearer ${aSession}`)
      .send({ id: bRow.id });
    expect(revoke.body.code).toBe(0);

    // B is revoked → 401. revokeById drops the KV entry by hash, so there is no 60s cache lag.
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
    await request(app.getHttpServer())
      .post('/api/v1/user/register')
      .send({ account: 'owner', name: 'Owner', password: 'Pass1234' })
      .expect((r) => expect(r.body.code).toBe(0));
    await request(app.getHttpServer())
      .post('/api/v1/user/register')
      .send({ account: 'intruder', name: 'Intruder', password: 'Pass1234' })
      .expect((r) => expect(r.body.code).toBe(0));

    const ownerSession: string = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ account: 'owner', password: 'Pass1234', client: 'app' })
    ).body.data.session_token;
    const intruderSession: string = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ account: 'intruder', password: 'Pass1234', client: 'app' })
    ).body.data.session_token;

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
});
