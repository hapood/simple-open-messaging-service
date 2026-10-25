import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { seedAdminSession } from './support/admin-session.js';
import request from 'supertest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service';
import {
  admin,
  adminActionLog,
  account as user,
  groupAccount,
} from '../src/database/schema';
import { ADMIN_SESSION_COOKIE } from '../src/admin/admin-session';
import { BusinessCode } from '../src/common/business-code';
import { AdminRole } from '../src/database/enums.js';
import { SessionTokenService } from '../src/auth/session-token.service.js';
import { SseService } from '../src/gateway/sse.service.js';
import { BruteForceService } from '../src/auth/brute-force.service.js';
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

  it('filters real user sessions and revokes only the selected credential', async () => {
    const operator = await seedAdmin('session-operator', AdminRole.ADMIN);
    const target = await seedUser('session-target');
    const sessions = app.get(SessionTokenService);
    const webToken = await sessions.issue(target.id, 'web', {
      ip: '192.0.2.10',
    });
    const desktopToken = await sessions.issue(target.id, 'desktop', {
      ip: '192.0.2.11',
    });
    const list = await post(operator.cookie, 'admin/sessions', {
      userId: target.id,
      client: 'web',
      ip: '192.0.2.10',
    });
    expect(list.body.code).toBe(BusinessCode.OK);
    expect(list.body.data.total).toBe(1);
    expect(list.body.data.list).toHaveLength(1);
    const id = list.body.data.list[0].id;
    await sessions.setAutoTerminateDays(target.id, 90);
    const updated = await post(operator.cookie, 'admin/sessions', {
      userId: target.id,
    });
    const perUser = await post(
      operator.cookie,
      `admin/users/${target.id}/sessions`,
    );
    const detail = await post(
      operator.cookie,
      `admin/users/${target.id}/detail`,
    );
    for (const rows of [
      updated.body.data.list,
      perUser.body.data,
      detail.body.data.sessions,
    ]) {
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.autoTerminateDays).toBe(90);
        expect(row.expiresAt).toBe(row.lastSeenAt + 90 * 86400000);
      }
    }
    const viewer = await seedAdmin('session-viewer', AdminRole.VIEWER);
    expect(
      (await post(viewer.cookie, `admin/sessions/${id}/revoke`)).body.code,
    ).toBe(BusinessCode.FORBIDDEN);
    expect(
      (await post(operator.cookie, `admin/sessions/${id}/revoke`)).body.code,
    ).toBe(BusinessCode.OK);
    expect(await sessions.validate(webToken)).toBeNull();
    expect(await sessions.validate(desktopToken)).not.toBeNull();
    expect((await post(operator.cookie, 'admin/me')).body.code).toBe(
      BusinessCode.OK,
    );
    const remaining = await post(operator.cookie, 'admin/sessions', {
      userId: target.id,
    });
    expect(
      remaining.body.data.list.map((row: { client: string }) => row.client),
    ).toEqual(['desktop']);
  });

  it('signs out all chat clients, including administrator accounts, without revoking console sessions', async () => {
    const operator = await seedAdmin('purge-operator', AdminRole.SUPER_ADMIN);
    const otherAdmin = await seedAdmin('purge-other', AdminRole.ADMIN);
    const target = await seedUser('purge-target');
    const sessions = app.get(SessionTokenService);
    const tokens = await Promise.all([
      sessions.issue(operator.userId, 'web'),
      sessions.issue(otherAdmin.userId, 'desktop'),
      sessions.issue(target.id, 'app'),
    ]);
    const result = await post(operator.cookie, 'admin/sessions/purge');
    expect(result.body.code).toBe(BusinessCode.OK);
    expect(result.body.data.purgedUsers).toBe(3);
    for (const token of tokens)
      expect(await sessions.validate(token)).toBeNull();
    expect(
      (await post(operator.cookie, 'admin/sessions')).body.data.total,
    ).toBe(0);
    for (const owner of [operator, otherAdmin]) {
      expect((await post(owner.cookie, 'admin/me')).body.code).toBe(
        BusinessCode.OK,
      );
    }
  });

  it.each([AdminRole.VIEWER, AdminRole.ADMIN, AdminRole.SUPER_ADMIN])(
    'enforces console-session ownership for %s and revokes immediately with audit',
    async (role) => {
      const owner = await seedAdmin('console-owner', role);
      const other = await seedAdmin('console-other', AdminRole.ADMIN);
      const extraToken = await seedAdminSession(database, owner.adminId);
      const extraCookie = `${ADMIN_SESSION_COOKIE}=${extraToken}`;
      const list = await post(owner.cookie, 'admin/admin-sessions');
      const current = list.body.data.list.find(
        (row: { isCurrent: boolean }) => row.isCurrent,
      );
      const ownOther = list.body.data.list.find(
        (row: { adminId: number; isCurrent: boolean }) =>
          row.adminId === owner.adminId && !row.isCurrent,
      );
      const foreign = list.body.data.list.find(
        (row: { adminId: number }) => row.adminId === other.adminId,
      );
      expect(current.canRevoke).toBe(false);
      expect(ownOther.canRevoke).toBe(true);
      expect(foreign.canRevoke).toBe(role === AdminRole.SUPER_ADMIN);
      expect(
        (await post(owner.cookie, `admin/admin-sessions/${current.id}/revoke`))
          .body.code,
      ).toBe(BusinessCode.FORBIDDEN);
      const foreignResult = await post(
        owner.cookie,
        `admin/admin-sessions/${foreign.id}/revoke`,
      );
      expect(foreignResult.body.code).toBe(
        role === AdminRole.SUPER_ADMIN
          ? BusinessCode.OK
          : BusinessCode.NOT_FOUND,
      );
      expect((await post(other.cookie, 'admin/me')).status).toBe(
        role === AdminRole.SUPER_ADMIN ? 401 : 200,
      );
      expect(
        (await post(owner.cookie, `admin/admin-sessions/${ownOther.id}/revoke`))
          .body.code,
      ).toBe(BusinessCode.OK);
      expect((await post(extraCookie, 'admin/me')).status).toBe(401);
      expect((await post(owner.cookie, 'admin/me')).body.code).toBe(
        BusinessCode.OK,
      );
      expect(
        (await post(owner.cookie, `admin/admin-sessions/${ownOther.id}/revoke`))
          .body.code,
      ).toBe(BusinessCode.NOT_FOUND);
      const audit = await database.db.query.adminActionLog.findMany({
        where: and(
          eq(adminActionLog.adminId, owner.adminId),
          eq(adminActionLog.action, 'admin_session.revoke'),
        ),
      });
      expect(audit.some((row) => row.targetId === ownOther.id)).toBe(true);
    },
  );

  it('rejects invalid console-session identifiers without a server error', async () => {
    const owner = await seedAdmin('invalid-id-owner', AdminRole.VIEWER);
    for (const id of ['invalid', '0', '-1', '999999999999999999999']) {
      expect(
        (await post(owner.cookie, `admin/admin-sessions/${id}/revoke`)).body
          .code,
      ).toBe(BusinessCode.VALIDATION_FAILED);
    }
  });

  it('closes only the revoked live SSE stream and keeps the other device usable', async () => {
    const operator = await seedAdmin('sse-operator', AdminRole.ADMIN);
    const target = await seedUser('sse-target');
    const sessions = app.get(SessionTokenService);
    const tokens = await Promise.all([
      sessions.issue(target.id, 'web'),
      sessions.issue(target.id, 'desktop'),
    ]);
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string')
      throw new Error('missing test server address');
    const aborter = new AbortController();
    const timer = setTimeout(() => aborter.abort(), 12_000).unref();
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const open = async (token: string) => {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/events`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: aborter.signal,
        },
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      readers.push(reader);
      let buffer = '';
      return {
        reader,
        async event(name: string) {
          const pattern = new RegExp(
            `event: ${name}\\r?\\n(?:id: [^\\r\\n]*\\r?\\n)?data: ([^\\r\\n]+)`,
          );
          for (;;) {
            const match = pattern.exec(buffer);
            if (match) {
              buffer = buffer.slice(match.index + match[0].length);
              return JSON.parse(match[1]);
            }
            const chunk = await reader.read();
            if (chunk.done) throw new Error(`SSE closed before ${name}`);
            buffer += new TextDecoder().decode(chunk.value);
          }
        },
      };
    };
    try {
      const first = await open(tokens[0]);
      const second = await open(tokens[1]);
      await first.event('HELLO');
      await second.event('HELLO');
      const list = await post(operator.cookie, 'admin/sessions', {
        userId: target.id,
        client: 'web',
      });
      const id = list.body.data.list[0].id;
      expect(
        (await post(operator.cookie, `admin/sessions/${id}/revoke`)).body.code,
      ).toBe(BusinessCode.OK);
      expect(await first.event('FORCE_LOGOUT')).toMatchObject({
        event: 'FORCE_LOGOUT',
        message: 'admin_revoke',
      });
      expect((await first.reader.read()).done).toBe(true);
      expect(
        app
          .get(SseService)
          .snapshot()
          .clients.find((entry) => entry.userId === target.id)?.connections,
      ).toBe(1);
      const survivor = await sessions.validate(tokens[1]);
      expect(survivor).not.toBeNull();
      app.get(SseService).onThreadFeedUpdated(target.id, {
        threadFeedEndId: 10,
        notificationRelevant: true,
      });
      expect(await second.event('THREAD_FEED_UPDATED')).toMatchObject({
        threadFeedEndId: 10,
      });
      const reconnect = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/events`,
        {
          headers: { Authorization: `Bearer ${tokens[0]}` },
          signal: aborter.signal,
        },
      );
      expect(reconnect.status).toBe(401);
      await reconnect.body?.cancel();
    } finally {
      clearTimeout(timer);
      aborter.abort();
      await Promise.all(
        readers.map((reader) => reader.cancel().catch(() => undefined)),
      );
    }
  });

  it('lists console roles and disabled access in the user roster without a separate admin list', async () => {
    const operator = await seedAdmin('roster-owner', AdminRole.SUPER_ADMIN);
    const target = await seedAdmin('roster-target', AdminRole.VIEWER);
    await post(operator.cookie, `admin/admins/${target.adminId}/disable`);
    const result = await post(operator.cookie, 'admin/users', {
      search: 'roster-target',
    });
    expect(result.body.code).toBe(BusinessCode.OK);
    expect(result.body.data.list).toEqual([
      expect.objectContaining({
        id: target.userId,
        adminId: target.adminId,
        adminRole: AdminRole.VIEWER,
        adminEnabled: false,
        adminTwoFactorEnabled: false,
        isDeleted: false,
      }),
    ]);
    expect((await post(operator.cookie, 'admin/admins')).status).toBe(404);
  });

  it('preserves console observations in user details without exposing credentials', async () => {
    const viewer = await seedAdmin('detail-viewer', AdminRole.VIEWER);
    const target = await seedAdmin('detail-target', AdminRole.ADMIN);
    const lastLoginAt = new Date('2026-01-02T03:04:05Z');
    await database.db
      .update(admin)
      .set({ enabled: false, twoFactorEnabled: true, lastLoginAt })
      .where(eq(admin.id, target.adminId));
    const result = await post(
      viewer.cookie,
      `admin/users/${target.userId}/detail`,
    );
    expect(result.body.code).toBe(BusinessCode.OK);
    expect(result.body.data.user).toMatchObject({
      adminRole: AdminRole.ADMIN,
      adminEnabled: false,
      adminTwoFactorEnabled: true,
      adminLastLoginAt: lastLoginAt.getTime(),
      isDeleted: false,
    });
    expect(result.body.data.user).not.toHaveProperty('hashPwd');
    expect(result.body.data.user).not.toHaveProperty('twoFactorSecret');
    const ordinary = await seedUser('detail-ordinary');
    const plain = await post(
      viewer.cookie,
      `admin/users/${ordinary.id}/detail`,
    );
    expect(plain.body.data.user).toMatchObject({
      adminRole: null,
      adminEnabled: null,
      adminTwoFactorEnabled: null,
      adminLastLoginAt: null,
    });
    const neverLoggedIn = await post(
      viewer.cookie,
      `admin/users/${viewer.userId}/detail`,
    );
    expect(neverLoggedIn.body.data.user.adminLastLoginAt).toBeNull();
  });

  it('resolves restrictions to exact local persons, never unknown accounts, groups or IPs', async () => {
    const viewer = await seedAdmin('restriction-viewer', AdminRole.VIEWER);
    const target = await seedUser('restriction-person');
    await database.db
      .update(user)
      .set({ disabledAt: new Date() })
      .where(eq(user.id, target.id));
    await database.db
      .insert(groupAccount)
      .values({ account: '!restriction-group' });
    const bruteForce = app.get(BruteForceService);
    const observations = [
      ['user', 'restriction-person'],
      ['otp', 'restriction-person'],
      ['admin_pwd', 'restriction-person'],
      ['admin_2fa', 'restriction-person'],
      ['user', 'restriction-pers'],
      ['user', 'restriction-unknown'],
      ['user', '!restriction-group'],
      ['ip', 'restriction-person'],
    ];
    try {
      for (const [dimension, value] of observations)
        bruteForce.registerFailure(dimension, value, [
          { count: 0, banMs: 60000 },
        ]);
      const result = await post(viewer.cookie, 'admin/bans');
      expect(result.body.code).toBe(BusinessCode.OK);
      for (const [type, value] of observations) {
        expect(result.body.data).toContainEqual(
          expect.objectContaining({
            type,
            value,
            userId:
              type !== 'ip' && value === 'restriction-person'
                ? target.id
                : null,
          }),
        );
      }
    } finally {
      for (const [, value] of observations)
        bruteForce.unban({ account: value, ip: value });
    }
  });

  it('releases all account restriction dimensions without enabling the account or clearing IP restrictions', async () => {
    const viewer = await seedAdmin('release-viewer', AdminRole.VIEWER);
    const operator = await seedAdmin('release-operator', AdminRole.ADMIN);
    const target = await seedUser('release-target');
    await database.db
      .update(user)
      .set({ disabledAt: new Date() })
      .where(eq(user.id, target.id));
    const bruteForce = app.get(BruteForceService);
    const dimensions = ['user', 'otp', 'admin_pwd', 'admin_2fa'];
    const ip = '192.0.2.42';
    try {
      for (const dimension of dimensions)
        bruteForce.registerFailure(dimension, 'release-target', [
          { count: 0, banMs: 60000 },
        ]);
      bruteForce.registerFailure('ip', ip, [{ count: 0, banMs: 60000 }]);
      expect(
        (
          await post(viewer.cookie, 'admin/bans/unban', {
            account: 'release-target',
          })
        ).body.code,
      ).toBe(BusinessCode.FORBIDDEN);
      expect(
        bruteForce.listBans().filter((ban) => ban.value === 'release-target'),
      ).toHaveLength(4);
      expect(
        (
          await post(operator.cookie, 'admin/bans/unban', {
            account: 'release-target',
          })
        ).body.code,
      ).toBe(BusinessCode.OK);
      expect(
        bruteForce.listBans().filter((ban) => ban.value === 'release-target'),
      ).toEqual([]);
      expect(
        bruteForce.activeBanUntil([{ dimension: 'ip', value: ip }]),
      ).toBeDefined();
      const account = await database.db.query.account.findFirst({
        where: eq(user.id, target.id),
      });
      expect(account?.disabledAt).toBeInstanceOf(Date);
      expect(
        (await post(operator.cookie, 'admin/bans/unban', { ip })).body.code,
      ).toBe(BusinessCode.OK);
      expect(
        bruteForce.activeBanUntil([{ dimension: 'ip', value: ip }]),
      ).toBeUndefined();
    } finally {
      bruteForce.unban({ account: 'release-target', ip });
    }
  });

  it('returns the operational dashboard to viewers without counting groups as registered users', async () => {
    const viewer = await seedAdmin('dashboard-viewer', AdminRole.VIEWER);
    await seedUser('dashboard-person');
    await database.db
      .insert(groupAccount)
      .values({ account: '!dashboard-group' });
    await app.get(SessionTokenService).issue(viewer.userId, 'web');
    const response = await post(viewer.cookie, 'admin/dashboard');
    expect(response.body.code).toBe(BusinessCode.OK);
    expect(response.body.data).toMatchObject({
      totalUsers: 2,
      activeSessions: 1,
      tasks: {
        processing: expect.any(Number),
        pending: expect.any(Number),
        failed: expect.any(Number),
      },
      transfers: {
        activeUploads: expect.any(Number),
        activeDownloads: expect.any(Number),
        failedTransfers: expect.any(Number),
      },
    });
    expect(response.body.data.federation.unrecognized).toBe(0);
  });

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
