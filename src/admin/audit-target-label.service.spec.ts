import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditTargetLabelService } from './audit-target-label.service.js';
import type { PrismaService } from '../prisma.service.js';

/**
 * AuditTargetLabelService.resolve — turns AdminActionLog targetIds into account names, shared by the
 * audit log (POST /admin/audit) and the dashboard's recent-actions strip (POST /admin/dashboard).
 * Locked down here:
 *  - per-type resolution: user / user_session / admin_session all land on the right join path and the
 *    right bucket (Int vs BigInt), returning the account name;
 *  - non-numeric / absent / unknown targets (peer domain, purge-all) are NOT resolved (absent from the
 *    map) and NOT queried;
 *  - empty buckets skip their findMany entirely (the N+1 guard), so rows touching only `user` never
 *    hit the sessionToken / adminSession / pushToken tables.
 *
 * Pure unit (Prisma mocked inline).
 */
function row(targetType: string | null, targetId: string | null) {
  return { targetType, targetId };
}

describe('AuditTargetLabelService.resolve', () => {
  function setup() {
    const prisma = {
      user: { findMany: vi.fn() },
      admin: { findMany: vi.fn() },
      sessionToken: { findMany: vi.fn() },
      adminSession: { findMany: vi.fn() },
      loginCode: { findMany: vi.fn() },
      pushToken: { findMany: vi.fn() },
      webAuthnCredential: { findMany: vi.fn() },
    };
    for (const m of Object.values(prisma)) m.findMany.mockResolvedValue([]);
    const svc = new AuditTargetLabelService(prisma as unknown as PrismaService);
    return { prisma, svc };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves each targetType to its account name and leaves non-resolvable targets out', async () => {
    const { prisma, svc } = setup();
    prisma.user.findMany.mockResolvedValue([{ id: 7, account: 'alice' }]);
    prisma.sessionToken.findMany.mockResolvedValue([{ id: 101, user: { account: 'bob' } }]);
    prisma.adminSession.findMany.mockResolvedValue([
      { id: 5n, admin: { user: { account: 'admin-carol' } } },
    ]);

    const map = await svc.resolve([
      row('user', '7'),
      row('user_session', '101'),
      row('admin_session', '5'), // BigInt id
      row('peer', 'example.com'), // non-numeric → skip (domain is its own label)
      row(null, null), // session.purge_all → no target
    ]);

    expect(map.get('user:7')).toBe('alice'); // user → User.account
    expect(map.get('user_session:101')).toBe('bob'); // user_session → SessionToken → User.account
    expect(map.get('admin_session:5')).toBe('admin-carol'); // admin_session (BigInt) → Admin → User.account
    expect(map.has('peer:example.com')).toBe(false); // not resolved (client falls back to targetId)
    expect(map.has(':')).toBe(false); // no-target row produces nothing
    // admin_session ids go into the BigInt IN-list, not the Int one.
    expect(prisma.adminSession.findMany).toHaveBeenCalledWith({
      where: { id: { in: [5n] } },
      select: { id: true, admin: { select: { user: { select: { account: true } } } } },
    });
  });

  it('skips the findMany for any target table that has no rows needing it (N+1 guard)', async () => {
    const { prisma, svc } = setup();
    prisma.user.findMany.mockResolvedValue([{ id: 7, account: 'alice' }]);

    await svc.resolve([row('user', '7')]);

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.sessionToken.findMany).not.toHaveBeenCalled();
    expect(prisma.adminSession.findMany).not.toHaveBeenCalled();
    expect(prisma.admin.findMany).not.toHaveBeenCalled();
    expect(prisma.pushToken.findMany).not.toHaveBeenCalled();
    expect(prisma.webAuthnCredential.findMany).not.toHaveBeenCalled();
    expect(prisma.loginCode.findMany).not.toHaveBeenCalled();
  });
});
