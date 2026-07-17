import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from './auth.service.js';
import type { PrismaService } from '../prisma.service.js';

/**
 * AuthService session-overview reads — the admin/device-management surface.
 *
 * The user-side session record is SessionToken (the single canonical credential — no RefreshToken
 * anymore). Locked down here:
 *  - listActiveSessions(): the per-user "Devices" list — reads SessionToken, the active filter admits
 *    no-expiry app tokens, the projected shape carries client/lastSeenIp/lastSeenAt, and the row whose
 *    id === currentSessionId is flagged isCurrent;
 *  - listAllSessions(): the system-wide admin overview — same SessionToken source, the ip filter
 *    matches BOTH the sign-in ip and the last-seen ip, and it returns { list, total };
 *  - purgeAllSessions(): discovers users from active SessionToken rows (deduped), revokes each, returns
 *    the count.
 *
 * Pure unit (Prisma mocked inline); invalidateAllSessions is spied so purge is tested in isolation.
 */
describe('AuthService (session overview → SessionToken)', () => {
  const prisma = {
    sessionToken: { findMany: vi.fn(), count: vi.fn() },
  };
  const svc = new AuthService(
    {} as never, // userService — unused by the methods under test
    prisma as unknown as PrismaService,
    { emit: vi.fn() } as never, // eventEmitter
    {} as never, // sessionTokens (revokeById/revokeAllForUser) — unused here
    {} as never, // passwordHasher — unused by the session-overview methods under test
  );

  /** A SessionToken row as Prisma would return it (Date fields; expiresAt nullable for app tokens). */
  function row(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 101,
      userId: 7,
      client: 'web',
      device: 'Chrome · macOS',
      userAgent: 'Mozilla/5.0…',
      ip: '203.0.113.10',
      lastSeenIp: '203.0.113.11',
      createdAt: new Date('2026-06-01T00:00:00Z'),
      lastSeenAt: new Date('2026-07-01T00:00:00Z'),
      expiresAt: new Date('2026-07-31T00:00:00Z'),
      ...overrides,
    };
  }

  beforeEach(() => {
    prisma.sessionToken.findMany.mockReset();
    prisma.sessionToken.count.mockReset();
    prisma.sessionToken.findMany.mockResolvedValue([]);
    prisma.sessionToken.count.mockResolvedValue(0);
  });

  // ── listActiveSessions (per-user "Devices" list) ────────────────────────────────────────────

  it('reads SessionToken, newest activity first, projecting client/lastSeenIp/lastSeenAt', async () => {
    prisma.sessionToken.findMany.mockResolvedValue([row({ id: 101 }), row({ id: 102 })]);
    await svc.listActiveSessions(7, null);

    const call = prisma.sessionToken.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      userId: 7,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
    });
    expect(call.orderBy).toEqual({ lastSeenAt: 'desc' });
    expect(call.select).toMatchObject({
      id: true,
      client: true,
      lastSeenIp: true,
      lastSeenAt: true,
      expiresAt: true,
    });
  });

  it('flags the row whose id === currentSessionId as isCurrent (and only that one)', async () => {
    prisma.sessionToken.findMany.mockResolvedValue([row({ id: 101 }), row({ id: 102 })]);
    const out = await svc.listActiveSessions(7, 102);
    const byId = new Map(out.map((s) => [s.id, s.isCurrent]));
    expect(byId.get(101)).toBe(false);
    expect(byId.get(102)).toBe(true);
    expect(out[0]).toMatchObject({
      client: 'web',
      ip: '203.0.113.10',
      lastSeenIp: '203.0.113.11',
      lastSeenAt: expect.any(Date),
    });
  });

  it('marks nothing isCurrent when currentSessionId is null (e.g. an admin viewing another user)', async () => {
    prisma.sessionToken.findMany.mockResolvedValue([row({ id: 101 }), row({ id: 102 })]);
    const out = await svc.listActiveSessions(7, null);
    expect(out.every((s) => s.isCurrent === false)).toBe(true);
  });

  // ── listAllSessions (system-wide admin overview) ────────────────────────────────────────────

  it('reads SessionToken and returns { list, total } with a matching count', async () => {
    prisma.sessionToken.findMany.mockResolvedValue([row({ id: 1, user: { id: 7, account: 'alice' } })]);
    prisma.sessionToken.count.mockResolvedValue(1);
    const out = await svc.listAllSessions({ skip: 0, take: 50 });

    expect(prisma.sessionToken.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.sessionToken.count).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ list: expect.any(Array), total: 1 });
    // Same where on both the page read and the count, so the total matches the filtered set.
    expect(prisma.sessionToken.count.mock.calls[0][0].where).toEqual(
      prisma.sessionToken.findMany.mock.calls[0][0].where,
    );
  });

  it('the active filter admits no-expiry app tokens (expiresAt null)', async () => {
    await svc.listAllSessions({});
    const where = prisma.sessionToken.findMany.mock.calls[0][0].where;
    expect(where.revokedAt).toBeNull();
    expect(where.AND[0]).toEqual({
      OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
    });
  });

  it('the ip filter matches BOTH the sign-in ip and the last-seen ip', async () => {
    await svc.listAllSessions({ ip: '203.0.113' });
    const and = prisma.sessionToken.findMany.mock.calls[0][0].where.AND as Array<
      Record<string, unknown>
    >;
    const ipClause = and.find(
      (c) => Array.isArray(c.OR) && c.OR.some((o) => 'ip' in o || 'lastSeenIp' in o),
    );
    expect(ipClause).toEqual({
      OR: [{ ip: { contains: '203.0.113' } }, { lastSeenIp: { contains: '203.0.113' } }],
    });
  });

  it('applies the userId filter into the AND clause', async () => {
    await svc.listAllSessions({ userId: 7 });
    const and = prisma.sessionToken.findMany.mock.calls[0][0].where.AND as unknown[];
    expect(and).toContainEqual({ userId: 7 });
  });

  // ── purgeAllSessions (force every user to re-login) ─────────────────────────────────────────

  it('discovers users from active SessionToken rows (deduped), revokes each, returns the count', async () => {
    prisma.sessionToken.findMany.mockResolvedValue([{ userId: 1 }, { userId: 1 }, { userId: 2 }]);
    const invalidate = vi.spyOn(svc, 'invalidateAllSessions').mockResolvedValue(undefined);

    const out = await svc.purgeAllSessions();

    expect(invalidate).toHaveBeenCalledTimes(2); // deduped {1, 2}
    expect(new Set(invalidate.mock.calls.map((c) => c[0]))).toEqual(new Set([1, 2]));
    expect(out).toEqual({ purgedUsers: 2 });
    invalidate.mockRestore();
  });

  it('admits no-expiry app tokens (expiresAt null) in the discovery filter', async () => {
    await svc.purgeAllSessions();
    const where = prisma.sessionToken.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
  });
});
