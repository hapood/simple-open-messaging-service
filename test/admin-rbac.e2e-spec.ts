import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';
import { AdminAuthService } from '../src/admin/admin-auth.service';
import { ADMIN_SESSION_COOKIE } from '../src/admin/admin-session';
import { BusinessCode } from '../src/common/business-code';
import { AdminRole } from '../src/prisma/generated/client.js';

/**
 * Admin security invariants e2e — the regression anchor for the RBAC + opaque-session revocation +
 * audit foundations. These invariants are pinned so a future refactor (someone weakening the
 * AdminRolesGuard tiers, or dropping the last-super guard, or revoking sessions on a no-op setRole)
 * fails loudly instead of silently.
 *
 *   1. RBAC tiers — reads open to VIEWER; routine mutations need ADMIN+; high-impact needs SUPER_ADMIN.
 *      Authorization failures surface as HTTP 200 + code 10004 (FORBIDDEN): the {code,message,data}
 *      envelope renders business errors at HTTP 200 by convention (business.exception.ts). Only a true
 *      auth failure — a revoked/disabled admin_session cookie making AdminAuthGuard throw — is HTTP 401.
 *      So RBAC assertions key on body.code (== 10004), NOT on HTTP status.
 *   2. Revocation is immediate — disabling/demoting an admin invalidates their outstanding
 *      admin_session cookie on its very next request (revokeSessionsByAdmin marks their AdminSession
 *      rows revoked, so validateAdminSession returns null). A no-op same-role setRole revokes nothing.
 *   3. Audit — every executed @Audit mutation writes an AdminActionLog row.
 *
 * Authz failures that a Guard rejects are NOT auditable here, and that is correct by construction:
 * NestJS runs Guards before Interceptors, so a 10004 from AdminRolesGuard short-circuits before the
 * AdminAuditInterceptor.intercept() is ever called. Successful mutations (and controller-thrown
 * business errors) are what the audit trail captures.
 */
describe('Admin RBAC + revocation + audit', () => {
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
    // CASCADE clears Admin, AdminSession, AdminActionLog (all FK-reachable from User), so each
    // case starts from an empty admin set.
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await app.close();
  });

  /** Seed a User + linked Admin of `role`, then mint an opaque admin_session directly (bypassing
   *  argon2 login) so the test stays fast. Returns the `admin_session=<token>` cookie pair to attach
   *  to admin-route requests — admin auth is cookie-carried, never a Bearer body token. */
  async function seedAdmin(
    account: string,
    role: AdminRole,
  ): Promise<{ adminId: number; userId: number; cookie: string }> {
    const user = await prisma.user.create({
      data: { account, domain: 'local', hashPwd: 'x', name: account, isForeigner: false },
      select: { id: true },
    });
    const admin = await prisma.admin.create({
      data: { userId: user.id, role, enabled: true },
      select: { id: true },
    });
    const token = await adminAuth.createAdminSession(admin.id, {});
    return { adminId: admin.id, userId: user.id, cookie: `${ADMIN_SESSION_COOKIE}=${token}` };
  }

  const seedUser = (account: string) =>
    prisma.user.create({
      data: { account, domain: 'local', hashPwd: 'x', name: account, isForeigner: false },
      select: { id: true },
    });

  const post = (cookie: string, path: string, body?: object) =>
    request(app.getHttpServer())
      .post('/api/v1/' + path)
      .set('Cookie', cookie)
      .send(body ?? {});

  // ── 1. RBAC tiers ─────────────────────────────────────────────────────────────
  it('VIEWER may read but is forbidden from routine + high-impact mutations', async () => {
    const viewer = await seedAdmin('viewer', AdminRole.VIEWER);
    const target = await seedUser('tgt');

    const read = await post(viewer.cookie, 'admin/users', { take: 5 });
    expect(read.status).toBe(200);
    expect(read.body.code).toBe(BusinessCode.OK);

    // routine mutation (disable user — ADMIN+) → FORBIDDEN (HTTP 200 + code 10004 by envelope)
    const routine = await post(viewer.cookie, `admin/users/${target.id}/disable`);
    expect(routine.body.code).toBe(BusinessCode.FORBIDDEN);

    // high-impact (purge all sessions — SUPER_ADMIN-only) → FORBIDDEN
    const hi = await post(viewer.cookie, 'admin/sessions/purge');
    expect(hi.body.code).toBe(BusinessCode.FORBIDDEN);
  });

  it('ADMIN passes routine mutations but is forbidden from SUPER_ADMIN-only ops', async () => {
    const admin = await seedAdmin('admin', AdminRole.ADMIN);
    const target = await seedUser('tgt2');

    const routine = await post(admin.cookie, `admin/users/${target.id}/disable`);
    expect(routine.status).toBe(200);
    expect(routine.body.code).toBe(BusinessCode.OK);

    // SUPER_ADMIN-only op (purge all sessions) → ADMIN is forbidden
    const hi = await post(admin.cookie, 'admin/sessions/purge');
    expect(hi.body.code).toBe(BusinessCode.FORBIDDEN);
  });

  // ── 2. Revocation is immediate ────────────────────────────────────────────────
  it('disabling an admin invalidates their outstanding session on the next request', async () => {
    const superA = await seedAdmin('super-a', AdminRole.SUPER_ADMIN);
    const superB = await seedAdmin('super-b', AdminRole.SUPER_ADMIN);

    // B's session cookie is valid before the disable.
    const before = await post(superB.cookie, 'admin/admins', { take: 5 });
    expect(before.status).toBe(200);

    // A disables B → revokeSessionsByAdmin('admin_disabled') marks B's AdminSession rows revoked
    // (and B.enabled flips false) inside the last-super-guarded transaction.
    const disable = await post(superA.cookie, `admin/admins/${superB.adminId}/disable`);
    expect(disable.body.code).toBe(BusinessCode.OK);

    // B's SAME previously-issued cookie now fails validation (revoked + disabled) → 401 / UNAUTHENTICATED.
    const after = await post(superB.cookie, 'admin/admins', { take: 5 });
    expect(after.status).toBe(401);
    expect(after.body.code).toBe(BusinessCode.UNAUTHENTICATED);
  });

  it('the last enabled super admin cannot be disabled or demoted', async () => {
    const only = await seedAdmin('only-super', AdminRole.SUPER_ADMIN);

    const disable = await post(only.cookie, `admin/admins/${only.adminId}/disable`);
    expect(disable.body.code).toBe(BusinessCode.FORBIDDEN); // last-super guard refused (HTTP 200 + code by envelope)

    const demote = await post(only.cookie, `admin/admins/${only.adminId}/role`, {
      role: AdminRole.ADMIN,
    });
    expect(demote.body.code).toBe(BusinessCode.FORBIDDEN);

    // Still enabled + still super — the guard refused before mutating.
    const row = await prisma.admin.findUnique({
      where: { id: only.adminId },
      select: { enabled: true, role: true },
    });
    expect(row?.enabled).toBe(true);
    expect(row?.role).toBe(AdminRole.SUPER_ADMIN);
  });

  it('a same-role setRole is a no-op (no session revocation)', async () => {
    const a = await seedAdmin('keep-super-a', AdminRole.SUPER_ADMIN);
    const b = await seedAdmin('keep-super-b', AdminRole.SUPER_ADMIN);

    // Re-affirming B's existing role writes the same value — guardedStateChange reports changed:false,
    // so setRole must NOT call revokeSessionsByAdmin.
    const r = await post(a.cookie, `admin/admins/${b.adminId}/role`, { role: AdminRole.SUPER_ADMIN });
    expect(r.body.code).toBe(BusinessCode.OK);

    // B's previously-issued cookie still validates → no kick.
    const stillValid = await post(b.cookie, 'admin/admins', { take: 5 });
    expect(stillValid.status).toBe(200);
    expect(stillValid.body.code).toBe(BusinessCode.OK);
  });

  // ── 3. Audit ──────────────────────────────────────────────────────────────────
  it('writes an AdminActionLog row (success) for an executed mutation', async () => {
    const actor = await seedAdmin('auditor', AdminRole.SUPER_ADMIN);
    const target = await seedAdmin('audited', AdminRole.SUPER_ADMIN);

    const r = await post(actor.cookie, `admin/admins/${target.adminId}/disable`);
    expect(r.body.code).toBe(BusinessCode.OK);

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
