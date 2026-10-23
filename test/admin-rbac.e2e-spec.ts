import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { seedAdminSession } from './support/admin-session.js';
import request from 'supertest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service';
import { admin, adminActionLog, account as user } from '../src/database/schema';
import { ADMIN_SESSION_COOKIE } from '../src/admin/admin-session';
import { BusinessCode } from '../src/common/business-code';
import { AdminRole } from '../src/database/enums.js';
import { SessionTokenService } from '../src/auth/session-token.service.js';
import { createTestApp } from './support/app';
import { truncateTablesForTest } from './support/truncate';

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
  let app: NestFastifyApplication;
  let database: DatabaseService;

  beforeAll(async () => {
    ({ app, database } = await createTestApp());
  });

  beforeEach(async () => {
    // CASCADE clears Admin, AdminSession, AdminActionLog (all FK-reachable from User), so each
    // case starts from an empty admin set.
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread" RESTART IDENTITY CASCADE',
    );
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
    const now = new Date();
    const [createdUser] = await database.db
      .insert(user)
      .values({
        account,
        namespaceId: 0,
        updatedAt: now,
      })
      .returning({ id: user.id });
    const [createdAdmin] = await database.db
      .insert(admin)
      .values({ userId: createdUser.id, role, enabled: true, updatedAt: now })
      .returning({ id: admin.id });
    const token = await seedAdminSession(database, createdAdmin.id);
    return {
      adminId: createdAdmin.id,
      userId: createdUser.id,
      cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
    };
  }

  const seedUser = async (account: string) => {
    const [created] = await database.db
      .insert(user)
      .values({
        account,
        namespaceId: 0,
        updatedAt: new Date(),
      })
      .returning({ id: user.id });
    return created;
  };

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
    const routine = await post(
      viewer.cookie,
      `admin/users/${target.id}/disable`,
    );
    expect(routine.body.code).toBe(BusinessCode.FORBIDDEN);

    // high-impact (purge all sessions — SUPER_ADMIN-only) → FORBIDDEN
    const hi = await post(viewer.cookie, 'admin/sessions/purge');
    expect(hi.body.code).toBe(BusinessCode.FORBIDDEN);
  });

  it('ADMIN passes routine mutations but is forbidden from SUPER_ADMIN-only ops', async () => {
    const admin = await seedAdmin('admin', AdminRole.ADMIN);
    const target = await seedUser('tgt2');

    const routine = await post(
      admin.cookie,
      `admin/users/${target.id}/disable`,
    );
    expect(routine.status).toBe(200);
    expect(routine.body.code).toBe(BusinessCode.OK);

    // SUPER_ADMIN-only op (purge all sessions) → ADMIN is forbidden
    const hi = await post(admin.cookie, 'admin/sessions/purge');
    expect(hi.body.code).toBe(BusinessCode.FORBIDDEN);
  });

  it('returns the current admin identity and revokes the opaque cookie on logout', async () => {
    const viewer = await seedAdmin('session-owner', AdminRole.VIEWER);

    const me = await post(viewer.cookie, 'admin/me');
    expect(me.status).toBe(200);
    expect(me.body.code).toBe(BusinessCode.OK);
    expect(me.body.data).toMatchObject({
      account: 'session-owner',
      role: AdminRole.VIEWER,
    });

    const logout = await post(viewer.cookie, 'admin/logout');
    expect(logout.status).toBe(200);
    expect(logout.body.code).toBe(BusinessCode.OK);
    // supertest types set-cookie as string, but node delivers an array of cookie strings.
    expect(
      (logout.headers['set-cookie'] as unknown as string[] | undefined)?.join(
        ';',
      ),
    ).toContain(`${ADMIN_SESSION_COOKIE}=;`);

    const after = await post(viewer.cookie, 'admin/me');
    expect(after.status).toBe(401);
    expect(after.body.code).toBe(BusinessCode.UNAUTHENTICATED);
  });

  // ── 2. Revocation is immediate ────────────────────────────────────────────────
  it('disabling an admin invalidates their outstanding session on the next request', async () => {
    const superA = await seedAdmin('super-a', AdminRole.SUPER_ADMIN);
    const superB = await seedAdmin('super-b', AdminRole.ADMIN);

    // B's session cookie is valid before the disable.
    const before = await post(superB.cookie, 'admin/users', { take: 5 });
    expect(before.status).toBe(200);

    // A disables B → revokeSessionsByAdmin('admin_disabled') marks B's AdminSession rows revoked
    // (and B.enabled flips false) inside the last-super-guarded transaction.
    const disable = await post(
      superA.cookie,
      `admin/admins/${superB.adminId}/disable`,
    );
    expect(disable.body.code).toBe(BusinessCode.OK);

    // B's SAME previously-issued cookie now fails validation (revoked + disabled) → 401 / UNAUTHENTICATED.
    const after = await post(superB.cookie, 'admin/users', { take: 5 });
    expect(after.status).toBe(401);
    expect(after.body.code).toBe(BusinessCode.UNAUTHENTICATED);
  });

  it('the last enabled super admin cannot be disabled or demoted', async () => {
    const only = await seedAdmin('only-super', AdminRole.SUPER_ADMIN);

    const disable = await post(
      only.cookie,
      `admin/admins/${only.adminId}/disable`,
    );
    expect(disable.body.code).toBe(BusinessCode.FORBIDDEN); // last-super guard refused (HTTP 200 + code by envelope)

    const demote = await post(
      only.cookie,
      `admin/admins/${only.adminId}/role`,
      {
        role: AdminRole.ADMIN,
      },
    );
    expect(demote.body.code).toBe(BusinessCode.FORBIDDEN);

    // Still enabled + still super — the guard refused before mutating.
    const [row] = await database.db
      .select({ enabled: admin.enabled, role: admin.role })
      .from(admin)
      .where(eq(admin.id, only.adminId))
      .limit(1);
    expect(row?.enabled).toBe(true);
    expect(row?.role).toBe(AdminRole.SUPER_ADMIN);

    const [failedAudit] = await database.db
      .select()
      .from(adminActionLog)
      .where(
        and(
          eq(adminActionLog.adminId, only.adminId),
          eq(adminActionLog.action, 'admin.disable'),
          eq(adminActionLog.targetId, String(only.adminId)),
        ),
      )
      .limit(1);
    expect(failedAudit).toMatchObject({
      status: 'FAILED',
      adminRole: AdminRole.SUPER_ADMIN,
    });
    expect(failedAudit?.errorMessage).toBeTruthy();
  });

  it('a same-role setRole is a no-op (no session revocation)', async () => {
    const a = await seedAdmin('keep-super-a', AdminRole.SUPER_ADMIN);
    const b = await seedAdmin('keep-super-b', AdminRole.ADMIN);

    // Re-affirming B's existing role writes the same value — guardedStateChange reports changed:false,
    // so setRole must NOT call revokeSessionsByAdmin.
    const r = await post(a.cookie, `admin/admins/${b.adminId}/role`, {
      role: AdminRole.ADMIN,
    });
    expect(r.body.code).toBe(BusinessCode.OK);

    // B's previously-issued cookie still validates → no kick.
    const stillValid = await post(b.cookie, 'admin/users', { take: 5 });
    expect(stillValid.status).toBe(200);
    expect(stillValid.body.code).toBe(BusinessCode.OK);
  });

  it('grants only VIEWER, only from SUPER_ADMIN, and removes the legacy create route', async () => {
    const root = await seedAdmin('root', AdminRole.SUPER_ADMIN);
    const operator = await seedAdmin('operator', AdminRole.ADMIN);
    const viewer = await seedAdmin('reader', AdminRole.VIEWER);
    const target = await seedUser('candidate');
    for (const actor of [operator, viewer]) {
      expect(
        (await post(actor.cookie, `admin/users/${target.id}/grant-viewer`)).body
          .code,
      ).toBe(BusinessCode.FORBIDDEN);
      expect(
        (
          await post(actor.cookie, `admin/admins/${viewer.adminId}/role`, {
            role: 'ADMIN',
          })
        ).body.code,
      ).toBe(BusinessCode.FORBIDDEN);
    }
    const grant = await post(
      root.cookie,
      `admin/users/${target.id}/grant-viewer`,
    );
    expect(grant.body.data.role).toBe('VIEWER');
    expect(
      (
        await post(root.cookie, `admin/admins/${grant.body.data.id}/role`, {
          role: 'SUPER_ADMIN',
        })
      ).body.code,
    ).not.toBe(BusinessCode.OK);
    expect(
      (
        await post(root.cookie, 'admin/admins/create', {
          userId: target.id,
          role: 'SUPER_ADMIN',
        })
      ).status,
    ).toBe(404);
  });

  it('protects administrator identities through generic user operations and role-based super protection', async () => {
    const root = await seedAdmin('not-the-admin-name', AdminRole.SUPER_ADMIN);
    const actor = await seedAdmin('admin', AdminRole.ADMIN);
    for (const action of [
      'disable',
      'enable',
      'force-logout',
      'issue-login-code',
    ]) {
      expect(
        (await post(actor.cookie, `admin/users/${root.userId}/${action}`)).body
          .code,
      ).toBe(BusinessCode.FORBIDDEN);
    }
    expect(
      (
        await post(actor.cookie, 'admin/users/batch', {
          ids: [root.userId],
          action: 'disable',
        })
      ).body.code,
    ).toBe(BusinessCode.FORBIDDEN);
    expect(
      (
        await post(root.cookie, `admin/admins/${root.adminId}/role`, {
          role: 'VIEWER',
        })
      ).body.code,
    ).toBe(BusinessCode.FORBIDDEN);
    // The literal account name does not confer protection or privilege.
    expect(
      (
        await post(root.cookie, `admin/admins/${actor.adminId}/role`, {
          role: 'VIEWER',
        })
      ).body.code,
    ).toBe(BusinessCode.OK);
  });

  it('rejects an OTP session finishing after an administrator grant', async () => {
    const target = await seedAdmin('otp-target', AdminRole.VIEWER);
    const sessions = app.get(SessionTokenService);
    await expect(
      sessions.issue(target.userId, 'app', { disallowAdmin: true }),
    ).rejects.toThrow();
  });

  it('serializes concurrent role change and disable without re-enabling access', async () => {
    const root = await seedAdmin('role-root', AdminRole.SUPER_ADMIN);
    const target = await seedAdmin('role-target', AdminRole.VIEWER);
    const results = await Promise.all([
      post(root.cookie, `admin/admins/${target.adminId}/role`, {
        role: 'ADMIN',
      }),
      post(root.cookie, `admin/admins/${target.adminId}/disable`),
    ]);
    expect(results.every((r) => r.body.code === BusinessCode.OK)).toBe(true);
    const row = await database.db.query.admin.findFirst({
      where: eq(admin.id, target.adminId),
    });
    expect(row).toMatchObject({ role: 'ADMIN', enabled: false });
    expect((await post(target.cookie, 'admin/me')).status).toBe(401);
  });

  it('checks account availability when validating backend sessions', async () => {
    const root = await seedAdmin('disabled-root', AdminRole.SUPER_ADMIN);
    await database.db
      .update(user)
      .set({ disabledAt: new Date() })
      .where(eq(user.id, root.userId));
    expect((await post(root.cookie, 'admin/me')).status).toBe(401);
  });

  it('serializes concurrent grants and user disable without leaving an enabled administrator on a disabled account', async () => {
    const root = await seedAdmin('concurrent-root', AdminRole.SUPER_ADMIN);
    const target = await seedUser('concurrent-target');
    const results = await Promise.all([
      post(root.cookie, `admin/users/${target.id}/grant-viewer`),
      post(root.cookie, `admin/users/${target.id}/disable`),
    ]);
    expect(results.filter((r) => r.body.code === BusinessCode.OK)).toHaveLength(
      1,
    );
    const [row] = await database.db
      .select({ disabledAt: user.disabledAt, role: admin.role })
      .from(user)
      .leftJoin(admin, eq(admin.userId, user.id))
      .where(eq(user.id, target.id));
    expect(row.role === null || row.disabledAt === null).toBe(true);
  });

  it('allows log reads for VIEWER but audits output changes only by ADMIN+', async () => {
    const viewer = await seedAdmin('log-reader', AdminRole.VIEWER);
    const actor = await seedAdmin('log-writer', AdminRole.ADMIN);
    expect(
      (await post(viewer.cookie, 'admin/logs/output-level')).body.code,
    ).toBe(BusinessCode.OK);
    expect(
      (
        await post(viewer.cookie, 'admin/logs/output-level/set', {
          level: 'error',
        })
      ).body.code,
    ).toBe(BusinessCode.FORBIDDEN);
    expect(
      (
        await post(actor.cookie, 'admin/logs/output-level/set', {
          level: 'error',
        })
      ).body.code,
    ).toBe(BusinessCode.OK);
    const logs = await database.db
      .select()
      .from(adminActionLog)
      .where(eq(adminActionLog.action, 'logs.output_level.set'));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      adminId: actor.adminId,
      status: 'SUCCEEDED',
    });
  });

  // ── 3. Audit ──────────────────────────────────────────────────────────────────
  it('marks an AdminActionLog row SUCCEEDED for an executed mutation', async () => {
    const actor = await seedAdmin('auditor', AdminRole.SUPER_ADMIN);
    const target = await seedAdmin('audited', AdminRole.ADMIN);

    const r = await post(
      actor.cookie,
      `admin/admins/${target.adminId}/disable`,
    );
    expect(r.body.code).toBe(BusinessCode.OK);

    const [log] = await database.db
      .select()
      .from(adminActionLog)
      .where(
        and(
          eq(adminActionLog.adminId, actor.adminId),
          eq(adminActionLog.action, 'admin.disable'),
          eq(adminActionLog.targetId, String(target.adminId)),
        ),
      )
      .limit(1);
    expect(log).toBeDefined();
    expect(log?.status).toBe('SUCCEEDED');
    expect(log?.adminRole).toBe(AdminRole.SUPER_ADMIN);
  });
});
