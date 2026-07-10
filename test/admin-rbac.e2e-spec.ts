import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';
import { AdminAuthService } from '../src/admin/admin-auth.service';
import { AdminRole } from '../src/prisma/generated/client.js';

/**
 * Admin security invariants e2e — the regression anchor for the Phase 1 RBAC + tokenVersion
 * revocation + audit foundations. These three invariants shipped without test coverage; this file
 * pins them so a future refactor (someone trimming AdminJwtStrategy's tver check, or dropping the
 * last-super guard) fails loudly instead of silently.
 *
 *   1. RBAC tiers — reads open to VIEWER; routine mutations need ADMIN+; high-impact needs SUPER_ADMIN.
 *      Authorization failures surface as HTTP 200 + code 10004 (FORBIDDEN): the {code,message,data}
 *      envelope renders business errors at HTTP 200 by convention (business.exception.ts). Only a true
 *      auth failure — a revoked/disabled token making AdminJwtStrategy return null — is HTTP 401.
 *      So RBAC assertions key on body.code (== 10004), NOT on HTTP status.
 *   2. Revocation is immediate — disabling/demoting an admin invalidates their outstanding access
 *      token on its very next request (tokenVersion bump) and revokes their refresh family.
 *   3. Audit — every executed @Audit mutation writes an AdminActionLog row.
 *
 * Authz failures that a Guard rejects are NOT auditable here, and that is correct by construction:
 * NestJS runs Guards before Interceptors, so a 403 from AdminRolesGuard short-circuits before the
 * AdminAuditInterceptor.intercept() is ever called. Successful mutations (and controller-thrown
 * business errors) are what the audit trail captures.
 */
describe('Admin RBAC + revocation + audit (Phase 1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: AdminAuthService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    prisma = app.get(PrismaService);
    adminAuth = app.get(AdminAuthService);
  });

  beforeEach(async () => {
    // CASCADE clears Admin, AdminRefreshToken, AdminActionLog (all FK-reachable from User), so each
    // case starts from an empty admin set.
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await app.close();
  });

  /** Seed a User + linked Admin of `role` (tokenVersion=0); return an access token minted for it.
   *  Bypasses argon2 login entirely (we sign the token directly) so the test stays fast. */
  async function seedAdmin(
    account: string,
    role: AdminRole,
  ): Promise<{ adminId: number; userId: number; token: string }> {
    const user = await prisma.user.create({
      data: { account, domain: 'local', hashPwd: 'x', name: account, isForeigner: false },
      select: { id: true },
    });
    const admin = await prisma.admin.create({
      data: { userId: user.id, role, enabled: true, tokenVersion: 0 },
      select: { id: true },
    });
    return { adminId: admin.id, userId: user.id, token: await adminAuth.getAdminAccessToken(admin.id) };
  }

  const seedUser = (account: string) =>
    prisma.user.create({
      data: { account, domain: 'local', hashPwd: 'x', name: account, isForeigner: false },
      select: { id: true },
    });

  const post = (token: string, path: string, body?: object) =>
    request(app.getHttpServer())
      .post('/api/v1/' + path)
      .set('Authorization', `Bearer ${token}`)
      .send(body ?? {});

  // ── 1. RBAC tiers ─────────────────────────────────────────────────────────────
  it('VIEWER may read but is forbidden from routine + high-impact mutations', async () => {
    const viewer = await seedAdmin('viewer', AdminRole.VIEWER);
    const target = await seedUser('tgt');

    const read = await post(viewer.token, 'admin/users', { take: 5 });
    expect(read.status).toBe(200);
    expect(read.body.code).toBe(0);

    // routine mutation (disable user — ADMIN+) → FORBIDDEN (HTTP 200 + code 10004 by envelope)
    const routine = await post(viewer.token, `admin/users/${target.id}/disable`);
    expect(routine.body.code).toBe(10004);

    // high-impact (reset-password — SUPER_ADMIN) → FORBIDDEN
    const hi = await post(viewer.token, `admin/users/${target.id}/reset-password`, {
      newPassword: 'NewP@ss2',
    });
    expect(hi.body.code).toBe(10004);
  });

  it('ADMIN passes routine mutations but is forbidden from SUPER_ADMIN-only ops', async () => {
    const admin = await seedAdmin('admin', AdminRole.ADMIN);
    const target = await seedUser('tgt2');

    const routine = await post(admin.token, `admin/users/${target.id}/disable`);
    expect(routine.status).toBe(200);
    expect(routine.body.code).toBe(0);

    const hi = await post(admin.token, `admin/users/${target.id}/reset-password`, {
      newPassword: 'NewP@ss2',
    });
    expect(hi.body.code).toBe(10004);
  });

  // ── 2. Revocation is immediate ────────────────────────────────────────────────
  it('disabling an admin invalidates their outstanding access token on the next request', async () => {
    const superA = await seedAdmin('super-a', AdminRole.SUPER_ADMIN);
    const superB = await seedAdmin('super-b', AdminRole.SUPER_ADMIN);

    // B's token is valid before the disable.
    const before = await post(superB.token, 'admin/admins', { take: 5 });
    expect(before.status).toBe(200);

    // A disables B → tokenVersion bumped inside the guarded transaction.
    const disable = await post(superA.token, `admin/admins/${superB.adminId}/disable`);
    expect(disable.body.code).toBe(0);

    // B's SAME previously-issued token now fails the tver check → 401 / UNAUTHENTICATED.
    const after = await post(superB.token, 'admin/admins', { take: 5 });
    expect(after.status).toBe(401);
    expect(after.body.code).toBe(10003);
  });

  it('a disabled admin refresh token is rejected on rotation (family revoked)', async () => {
    const superA = await seedAdmin('super-a2', AdminRole.SUPER_ADMIN);
    const superB = await seedAdmin('super-b2', AdminRole.SUPER_ADMIN);
    const refresh = await adminAuth.getAdminRefreshToken(superB.adminId, {});

    await post(superA.token, `admin/admins/${superB.adminId}/disable`);

    const rot = await request(app.getHttpServer())
      .post('/api/v1/admin/renew-access')
      .send({ refreshToken: refresh });
    // The family was revoked → rotation must NOT succeed.
    expect(rot.body.code).not.toBe(0);
  });

  it('the last enabled super admin cannot be disabled or demoted', async () => {
    const only = await seedAdmin('only-super', AdminRole.SUPER_ADMIN);

    const disable = await post(only.token, `admin/admins/${only.adminId}/disable`);
    expect(disable.body.code).toBe(10004); // last-super guard refused (HTTP 200 + code by envelope)

    const demote = await post(only.token, `admin/admins/${only.adminId}/role`, {
      role: AdminRole.ADMIN,
    });
    expect(demote.body.code).toBe(10004);

    // Still enabled + still super — the guard refused before mutating.
    const row = await prisma.admin.findUnique({
      where: { id: only.adminId },
      select: { enabled: true, role: true },
    });
    expect(row?.enabled).toBe(true);
    expect(row?.role).toBe(AdminRole.SUPER_ADMIN);
  });

  it('a same-role setRole is a no-op (no session kick, no tokenVersion bump)', async () => {
    const a = await seedAdmin('keep-super-a', AdminRole.SUPER_ADMIN);
    const b = await seedAdmin('keep-super-b', AdminRole.SUPER_ADMIN);
    const beforeTver = await prisma.admin.findUnique({
      where: { id: b.adminId },
      select: { tokenVersion: true },
    });

    const r = await post(a.token, `admin/admins/${b.adminId}/role`, { role: AdminRole.SUPER_ADMIN });
    expect(r.body.code).toBe(0);

    const afterTver = await prisma.admin.findUnique({
      where: { id: b.adminId },
      select: { tokenVersion: true },
    });
    // Re-affirming the same role must not invalidate the admin's sessions.
    expect(afterTver?.tokenVersion).toBe(beforeTver?.tokenVersion);
  });

  // ── 3. Audit ──────────────────────────────────────────────────────────────────
  it('writes an AdminActionLog row (success) for an executed mutation', async () => {
    const actor = await seedAdmin('auditor', AdminRole.SUPER_ADMIN);
    const target = await seedAdmin('audited', AdminRole.SUPER_ADMIN);

    const r = await post(actor.token, `admin/admins/${target.adminId}/disable`);
    expect(r.body.code).toBe(0);

    const log = await prisma.adminActionLog.findFirst({
      where: {
        adminId: actor.adminId,
        action: 'admin.disable',
        targetId: String(target.adminId),
      },
    });
    expect(log).not.toBeNull();
    expect(log?.success).toBe(true);
    expect(log?.adminRole).toBe(AdminRole.SUPER_ADMIN);
  });
});
