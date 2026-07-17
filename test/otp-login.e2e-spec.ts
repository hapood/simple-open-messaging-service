import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';
import { OtpLoginService } from '../src/auth/otp-login.service';
import { BusinessCode } from '../src/common/business-code';

/**
 * OTP-login e2e — the admin-issued one-time-code → long-term Android `app` session path, exercised through
 * the real HTTP surface (ThrottleGuard + SessionAuthGuard + the global filter) + argon2 + Prisma.
 *
 * Seeding is DIRECT: in the admin-provisioned model self-registration is closed AND an OTP account carries
 * no password, so POST /user/register is neither available nor correct for these fixtures. The user is
 * inserted via Prisma and the code is minted through OtpLoginService directly (admin auth is a separate
 * concern); what is under test is the /auth/otp/login endpoint and the one-app-session replacement rule.
 */
describe('OTP login e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let otp: OtpLoginService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    prisma = app.get(PrismaService);
    otp = app.get(OtpLoginService);
  });

  beforeEach(async () => {
    // CASCADE on User also clears SessionToken + LoginCode (both FK→User). All three are listed so a stray
    // row can't leak between tests even if an on-delete weren't CASCADE.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "LoginCode", "SessionToken", "User" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  /** Seed a passwordless (OTP-only) account; return its id. */
  async function seedOtpAccount(account: string): Promise<number> {
    const u = await prisma.user.create({
      data: { account, domain: 'local', name: account, hashPwd: null, mustChangePassword: false, isForeigner: false },
      select: { id: true },
    });
    return u.id;
  }

  /** True iff the token reaches an authenticated route (code 0). */
  async function guardedOk(token: string): Promise<boolean> {
    const r = await request(app.getHttpServer())
      .post('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${token}`);
    return r.body.code === 0;
  }

  it('issues a code, logs in to an `app` session, and the session authenticates a guarded route', async () => {
    const userId = await seedOtpAccount('otphappy');
    const { code } = await otp.issueCode(userId, userId); // issuedBy is a plain audit Int (no FK)

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/login')
      .send({ account: 'otphappy', code });
    expect(login.body.code).toBe(0);
    const token: string = login.body.data.session_token;
    expect(token).toBeTruthy();

    expect(await guardedOk(token)).toBe(true);
  });

  it('a second OTP login leaves the prior app session intact (multiple trusted devices coexist)', async () => {
    const userId = await seedOtpAccount('otpreplace');

    const codeA = (await otp.issueCode(userId, userId)).code;
    const loginA = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/login')
      .send({ account: 'otpreplace', code: codeA });
    const tokenA: string = loginA.body.data.session_token;
    expect(await guardedOk(tokenA)).toBe(true); // A works before the second login (populates its KV cache)

    const codeB = (await otp.issueCode(userId, userId)).code;
    const loginB = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/login')
      .send({ account: 'otpreplace', code: codeB });
    expect(loginB.body.code).toBe(0);
    const tokenB: string = loginB.body.data.session_token;

    // The one-app-session rule was removed: A is NOT revoked by the second login — both trusted app
    // sessions coexist, each independently revocable from the device list.
    expect(await guardedOk(tokenA)).toBe(true);
    expect(await guardedOk(tokenB)).toBe(true);

    // No session is stamped with the now-removed replacement reason.
    const replaced = await prisma.sessionToken.findFirst({
      where: { userId, revokeReason: 'app_session_replaced' },
    });
    expect(replaced).toBeNull();
  });

  it('rejects a wrong code with the precise OTP_INVALID business code', async () => {
    const userId = await seedOtpAccount('otpwrong');
    await otp.issueCode(userId, userId);
    const r = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/login')
      .send({ account: 'otpwrong', code: '000000' }); // well-formed 6 digits, wrong
    expect(r.body.code).toBe(BusinessCode.OTP_INVALID);
  });
});
