import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';
import { PrismaClient } from '../src/prisma/generated/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { AdminRole } from '../src/prisma/generated/client.js';
import { ADMIN_SESSION_COOKIE } from '../src/admin/admin-session';
import { BusinessCode } from '../src/common/business-code';

/**
 * AdminBootstrapService e2e — boots the REAL AppModule against a real Postgres and asserts the
 * OnApplicationBootstrap hook self-seeds the bootstrap admin exactly as production boots. This is the
 * end-to-end anchor for the wiring the unit spec (admin-bootstrap.service.spec.ts) mocks: Nest DI
 * resolves the provider, the lifecycle hook fires on listen, argon2 hashes against the live DB, and the
 * admin/login endpoint accepts the seeded password.
 *
 * Three branches:
 *   1. ADMIN_BOOTSTRAP_PASSWORD set + no admin → creates User(account=admin) + Admin(SUPER_ADMIN, enabled),
 *      and the password logs in via HTTP admin/login (argon2 round-trip through the real row);
 *   2. ADMIN_BOOTSTRAP_PASSWORD unset + no admin → the app STILL boots, no admin is created (no weak
 *      default), and login is rejected;
 *   3. idempotent → a second boot with the admin already present creates no duplicate.
 */
const BOOT_PWD = 'bootstrap-e2e-password';

/** Standalone client for pre-boot cleanup (the fork DB persists across runs; truncate before each case so
 *  every boot starts from an empty User table — CASCADE reaches Admin / tokens / audit logs). */
let cleanup: PrismaClient;

beforeAll(async () => {
  cleanup = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
});

afterAll(async () => {
  await cleanup?.$disconnect();
});

beforeEach(async () => {
  await cleanup.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
});

/** Boot a fresh AppModule+Fastify app (OnApplicationBootstrap fires during listen). */
async function bootApp(): Promise<{ app: INestApplication; prisma: PrismaService }> {
  const module: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const adapter = new FastifyAdapter();
  const app = module.createNestApplication(adapter);
  await configureApp(app, adapter);
  await app.listen(0);
  return { app, prisma: app.get(PrismaService) };
}

describe('AdminBootstrapService (e2e — app self-seeds the bootstrap admin on boot)', () => {
  it('creates account=admin (SUPER_ADMIN, enabled) when ADMIN_BOOTSTRAP_PASSWORD is set', async () => {
    process.env.ADMIN_BOOTSTRAP_PASSWORD = BOOT_PWD;
    const { app, prisma } = await bootApp();
    try {
      const user = await prisma.user.findUnique({
        where: { account_domain: { account: 'admin', domain: 'local' } },
        include: { admins: { select: { role: true, enabled: true } } },
      });
      expect(user).not.toBeNull();
      expect(user!.account).toBe('admin');
      expect(user!.isForeigner).toBe(false);
      expect(user!.admins).toHaveLength(1);
      expect(user!.admins[0].role).toBe(AdminRole.SUPER_ADMIN);
      expect(user!.admins[0].enabled).toBe(true);

      // The seeded password logs in through the real HTTP endpoint — argon2.verify against the live row.
      const login = await request(app.getHttpServer())
        .post('/api/v1/admin/login')
        .send({ account: 'admin', password: BOOT_PWD });
      expect(login.status).toBe(200);
      expect(login.body.code).toBe(BusinessCode.OK);
      // The session is delivered via the httpOnly admin_session cookie, not a response-body token.
      expect(login.body.data?.authenticated).toBe(true);
      expect(String(login.headers['set-cookie'])).toContain(ADMIN_SESSION_COOKIE);
    } finally {
      await app.close();
    }
  });

  it('boots fine and creates NO admin when ADMIN_BOOTSTRAP_PASSWORD is unset (no weak default)', async () => {
    delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    const { app, prisma } = await bootApp();
    try {
      const user = await prisma.user.findUnique({
        where: { account_domain: { account: 'admin', domain: 'local' } },
      });
      expect(user).toBeNull();

      const login = await request(app.getHttpServer())
        .post('/api/v1/admin/login')
        .send({ account: 'admin', password: 'anything' });
      expect(login.body.code).not.toBe(BusinessCode.OK); // INVALID_CREDENTIALS — no admin row to verify against
    } finally {
      await app.close();
    }
  });

  it('is idempotent — a second boot with the admin present creates no duplicate', async () => {
    process.env.ADMIN_BOOTSTRAP_PASSWORD = BOOT_PWD;

    const first = await bootApp();
    const afterFirst = await first.prisma.user.count({ where: { account: 'admin', domain: 'local' } });
    await first.app.close();
    expect(afterFirst).toBe(1);

    // Second boot: the bootstrap finds account=admin already present and must skip (no duplicate row/admin).
    const second = await bootApp();
    try {
      const users = await second.prisma.user.count({ where: { account: 'admin', domain: 'local' } });
      const admins = await second.prisma.admin.count();
      expect(users).toBe(1);
      expect(admins).toBe(1);
    } finally {
      await second.app.close();
    }
  });
});
