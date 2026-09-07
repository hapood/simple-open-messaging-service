import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditTargetLabelService } from './audit-target-label.service.js';
import {
  admin,
  adminSession,
  loginCode,
  pushToken,
  sessionToken,
  account as user,
  webAuthnCredential,
} from '../database/schema.js';

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
 * Pure unit (Drizzle mocked inline).
 */
function row(targetType: string | null, targetId: string | null) {
  return { targetType, targetId };
}

describe('AuditTargetLabelService.resolve', () => {
  function setup() {
    const queries = {
      user: vi.fn(),
      admin: vi.fn(),
      sessionToken: vi.fn(),
      adminSession: vi.fn(),
      loginCode: vi.fn(),
      pushToken: vi.fn(),
      webAuthnCredential: vi.fn(),
    };
    for (const query of Object.values(queries)) query.mockResolvedValue([]);
    const byTable = new Map<unknown, ReturnType<typeof vi.fn>>([
      [user, queries.user],
      [admin, queries.admin],
      [sessionToken, queries.sessionToken],
      [adminSession, queries.adminSession],
      [loginCode, queries.loginCode],
      [pushToken, queries.pushToken],
      [webAuthnCredential, queries.webAuthnCredential],
    ]);
    const database = {
      db: {
        select: vi.fn(() => ({
          from: vi.fn((table: unknown) => {
            const query = byTable.get(table)!;
            const builder = {
              innerJoin: vi.fn(() => builder),
              where: vi.fn(() => query()),
            };
            return builder;
          }),
        })),
      },
    };
    const svc = new AuditTargetLabelService(database as never);
    return { queries, svc };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves each targetType to its account name and leaves non-resolvable targets out', async () => {
    const { queries, svc } = setup();
    queries.user.mockResolvedValue([{ id: 7, account: 'alice' }]);
    queries.sessionToken.mockResolvedValue([{ id: 101, account: 'bob' }]);
    queries.adminSession.mockResolvedValue([
      { id: 5n, account: 'admin-carol' },
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
    expect(queries.adminSession).toHaveBeenCalledTimes(1);
  });

  it('skips the findMany for any target table that has no rows needing it (N+1 guard)', async () => {
    const { queries, svc } = setup();
    queries.user.mockResolvedValue([{ id: 7, account: 'alice' }]);

    await svc.resolve([row('user', '7')]);

    expect(queries.user).toHaveBeenCalledTimes(1);
    expect(queries.sessionToken).not.toHaveBeenCalled();
    expect(queries.adminSession).not.toHaveBeenCalled();
    expect(queries.admin).not.toHaveBeenCalled();
    expect(queries.pushToken).not.toHaveBeenCalled();
    expect(queries.webAuthnCredential).not.toHaveBeenCalled();
    expect(queries.loginCode).not.toHaveBeenCalled();
  });
});
