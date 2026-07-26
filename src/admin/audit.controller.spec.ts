import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditController } from './audit.controller.js';
import type { PrismaService } from '../prisma.service.js';

/**
 * AuditController.list — target-label resolution (attachTargetLabels). The list endpoint joins each
 * row's targetId into an account name by targetType. Locked down here:
 *  - per-type resolution: user / user_session / admin_session all land on the right join path and the
 *    right bucket (Int vs BigInt), returning the account name;
 *  - non-numeric / absent / unknown targets (peer domain, purge-all) are NOT resolved (null) and NOT
 *    queried;
 *  - empty buckets skip their findMany entirely (the N+1 guard), so a page touching only `user` rows
 *    never hits the sessionToken / adminSession / pushToken tables.
 *
 * Pure unit (Prisma mocked inline). Rows are plain objects shaped like the select in list().
 */

/** A minimal AdminActionLog row (the fields list() selects); callers override targetType/targetId. */
function row(id: number, targetType: string | null, targetId: string | null): Record<string, unknown> {
  return {
    id: BigInt(id),
    adminId: 1,
    adminRole: 'SUPER_ADMIN',
    action: 'x',
    targetType,
    targetId,
    ip: null,
    userAgent: null,
    route: null,
    success: true,
    errorMessage: null,
    at: new Date(),
  };
}

describe('AuditController.list (target-label resolution)', () => {
  function setup() {
    const prisma = {
      adminActionLog: { findMany: vi.fn(), count: vi.fn() },
      user: { findMany: vi.fn() },
      admin: { findMany: vi.fn() },
      sessionToken: { findMany: vi.fn() },
      adminSession: { findMany: vi.fn() },
      loginCode: { findMany: vi.fn() },
      pushToken: { findMany: vi.fn() },
      webAuthnCredential: { findMany: vi.fn() },
    };
    // Default every target-table lookup to empty so unconfigured ones are harmless.
    for (const m of [
      prisma.user,
      prisma.admin,
      prisma.sessionToken,
      prisma.adminSession,
      prisma.loginCode,
      prisma.pushToken,
      prisma.webAuthnCredential,
    ]) {
      m.findMany.mockResolvedValue([]);
    }
    prisma.adminActionLog.count.mockResolvedValue(0);
    const ctrl = new AuditController(prisma as unknown as PrismaService);
    return { prisma, ctrl };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves each targetType to its account name and leaves non-resolvable targets null', async () => {
    const { prisma, ctrl } = setup();
    prisma.adminActionLog.findMany.mockResolvedValue([
      row(1, 'user', '7'),
      row(2, 'user_session', '101'),
      row(3, 'admin_session', '5'), // BigInt id
      row(4, 'peer', 'example.com'), // non-numeric targetId → skip (domain is its own label)
      row(5, null, null), // session.purge_all → no target
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 7, account: 'alice' }]);
    prisma.sessionToken.findMany.mockResolvedValue([{ id: 101, user: { account: 'bob' } }]);
    prisma.adminSession.findMany.mockResolvedValue([
      { id: 5n, admin: { user: { account: 'admin-carol' } } },
    ]);

    const res = await ctrl.list({ skip: 0, take: 50 });
    const list = (res.data as { list: Array<{ id: bigint; targetLabel: string | null }> }).list;
    const labelOf = (id: number) => list.find((r) => Number(r.id) === id)?.targetLabel;

    expect(labelOf(1)).toBe('alice'); // user → User.account
    expect(labelOf(2)).toBe('bob'); // user_session → SessionToken → User.account
    expect(labelOf(3)).toBe('admin-carol'); // admin_session (BigInt) → AdminSession → Admin → User.account
    expect(labelOf(4)).toBeNull(); // peer domain not resolved (client falls back to targetId)
    expect(labelOf(5)).toBeNull(); // no target

    // admin_session ids go into the BigInt IN-list, not the Int one.
    expect(prisma.adminSession.findMany).toHaveBeenCalledWith({
      where: { id: { in: [5n] } },
      select: { id: true, admin: { select: { user: { select: { account: true } } } } },
    });
  });

  it('skips the findMany for any target table that has no rows needing it (N+1 guard)', async () => {
    const { prisma, ctrl } = setup();
    prisma.adminActionLog.findMany.mockResolvedValue([row(1, 'user', '7')]);
    prisma.user.findMany.mockResolvedValue([{ id: 7, account: 'alice' }]);

    await ctrl.list({ skip: 0, take: 50 });

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.sessionToken.findMany).not.toHaveBeenCalled();
    expect(prisma.adminSession.findMany).not.toHaveBeenCalled();
    expect(prisma.admin.findMany).not.toHaveBeenCalled();
    expect(prisma.pushToken.findMany).not.toHaveBeenCalled();
    expect(prisma.webAuthnCredential.findMany).not.toHaveBeenCalled();
    expect(prisma.loginCode.findMany).not.toHaveBeenCalled();
  });
});
