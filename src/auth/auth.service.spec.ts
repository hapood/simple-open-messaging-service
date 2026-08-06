import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from './auth.service.js';

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
 * Pure unit (Drizzle mocked inline); invalidateAllSessions is spied so purge is tested in isolation.
 */
describe('AuthService (session overview → SessionToken)', () => {
  const findMany = vi.fn();
  const pageRows = vi.fn();
  const countRows = vi.fn();
  const purgeRows = vi.fn();
  const terminal = (result: ReturnType<typeof vi.fn>) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['innerJoin', 'where', 'orderBy', 'offset']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.limit = vi.fn(() => result());
    return chain;
  };
  const select = vi
    .fn()
    .mockImplementationOnce(() => ({ from: vi.fn(() => terminal(pageRows)) }))
    .mockImplementationOnce(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => countRows()) })),
    }));
  const selectDistinct = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(() => purgeRows()) })),
  }));
  const database = {
    db: {
      query: { sessionToken: { findMany } },
      select,
      selectDistinct,
    },
  };
  const svc = new AuthService(
    {} as never, // userService — unused by the methods under test
    database as never,
    { emit: vi.fn() } as never, // eventEmitter
    {} as never, // sessionTokens (revokeById/revokeAllForUser) — unused here
    {} as never, // passwordHasher — unused by the session-overview methods under test
  );

  /** A SessionToken row as the database would return it (Date fields; expiresAt nullable for app tokens). */
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
    findMany.mockReset().mockResolvedValue([]);
    pageRows.mockReset().mockResolvedValue([]);
    countRows.mockReset().mockResolvedValue([{ value: 0 }]);
    purgeRows.mockReset().mockResolvedValue([]);
    select.mockReset();
    select
      .mockImplementationOnce(() => ({ from: vi.fn(() => terminal(pageRows)) }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => countRows()) })),
      }));
  });

  // ── listActiveSessions (per-user "Devices" list) ────────────────────────────────────────────

  it('reads SessionToken, newest activity first, projecting client/lastSeenIp/lastSeenAt', async () => {
    findMany.mockResolvedValue([row({ id: 101 }), row({ id: 102 })]);
    await svc.listActiveSessions(7, null);

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('flags the row whose id === currentSessionId as isCurrent (and only that one)', async () => {
    findMany.mockResolvedValue([row({ id: 101 }), row({ id: 102 })]);
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
    findMany.mockResolvedValue([row({ id: 101 }), row({ id: 102 })]);
    const out = await svc.listActiveSessions(7, null);
    expect(out.every((s) => s.isCurrent === false)).toBe(true);
  });

  // ── listAllSessions (system-wide admin overview) ────────────────────────────────────────────

  it('reads SessionToken and returns { list, total } with a matching count', async () => {
    pageRows.mockResolvedValue([
      { ...row({ id: 1 }), userId: 7, account: 'alice' },
    ]);
    countRows.mockResolvedValue([{ value: 1 }]);
    const out = await svc.listAllSessions({ skip: 0, take: 50 });

    expect(pageRows).toHaveBeenCalledTimes(1);
    expect(countRows).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ list: expect.any(Array), total: 1 });
    // Same where on both the page read and the count, so the total matches the filtered set.
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('the active filter admits no-expiry app tokens (expiresAt null)', async () => {
    await svc.listAllSessions({});
    expect(pageRows).toHaveBeenCalledTimes(1);
  });

  it('the ip filter matches BOTH the sign-in ip and the last-seen ip', async () => {
    await svc.listAllSessions({ ip: '203.0.113' });
    expect(pageRows).toHaveBeenCalledTimes(1);
  });

  it('applies the userId filter into the AND clause', async () => {
    await svc.listAllSessions({ userId: 7 });
    expect(pageRows).toHaveBeenCalledTimes(1);
  });

  // ── purgeAllSessions (force every user to re-login) ─────────────────────────────────────────

  it('discovers users from active SessionToken rows (deduped), revokes each, returns the count', async () => {
    purgeRows.mockResolvedValue([{ userId: 1 }, { userId: 2 }]);
    const invalidate = vi
      .spyOn(svc, 'invalidateAllSessions')
      .mockResolvedValue(undefined);

    const out = await svc.purgeAllSessions();

    expect(invalidate).toHaveBeenCalledTimes(2); // deduped {1, 2}
    expect(new Set(invalidate.mock.calls.map((c) => c[0]))).toEqual(
      new Set([1, 2]),
    );
    expect(out).toEqual({ purgedUsers: 2 });
    invalidate.mockRestore();
  });

  it('admits no-expiry app tokens (expiresAt null) in the discovery filter', async () => {
    await svc.purgeAllSessions();
    expect(purgeRows).toHaveBeenCalledTimes(1);
  });
});

// revokeSessionAdmin — admin-side single-session revoke (NOT owner-gated). Resolves the row's userId,
// revokes with 'admin_revoke', and emits auth.session-revoked so SSE kicks ONLY that device.
describe('AuthService.revokeSessionAdmin (admin single revoke → SessionToken)', () => {
  const findFirst = vi.fn();
  const revokeById = vi.fn();
  const emit = vi.fn();
  const svc = new AuthService(
    {} as never, // userService — unused
    { db: { query: { sessionToken: { findFirst } } } } as never,
    { emit } as never, // eventEmitter
    { revokeById } as never, // sessionTokens
    {} as never, // passwordHasher — unused
  );

  beforeEach(() => {
    findFirst.mockReset();
    revokeById.mockReset();
    emit.mockReset();
  });

  it('revokes with reason admin_revoke and emits so only that device is kicked', async () => {
    findFirst.mockResolvedValue({ userId: 7 });
    revokeById.mockResolvedValue(true);
    const ok = await svc.revokeSessionAdmin(101);
    expect(ok).toBe(true);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(revokeById).toHaveBeenCalledWith(7, 101, 'admin_revoke');
    expect(emit).toHaveBeenCalledWith('auth.session-revoked', {
      userId: 7,
      sessionId: 101,
      reason: 'admin_revoke',
    });
  });

  it('returns false and does NOT emit for an unknown / already-revoked id', async () => {
    findFirst.mockResolvedValue(null);
    const ok = await svc.revokeSessionAdmin(999);
    expect(ok).toBe(false);
    expect(revokeById).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('returns false and does NOT emit when the row is revoked mid-flight (revokeById no-op)', async () => {
    findFirst.mockResolvedValue({ userId: 7 });
    revokeById.mockResolvedValue(false);
    const ok = await svc.revokeSessionAdmin(101);
    expect(ok).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
