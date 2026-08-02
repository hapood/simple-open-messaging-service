import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionTokenService } from './session-token.service.js';
import { sessionToken, user } from '../database/schema.js';
import type { KvStoreService } from '../kv-store/kv-store.service.js';

/**
 * SessionTokenService: issue/validate/revoke of the long-lived per-device session credential. Pure
 * unit tests (Drizzle + KV mocked inline) covering the app(no-expiry)/web·desktop(sliding) lifetime
 * policies, client/lastSeenIp persistence, the KV validate cache, revocation/expiry/unknown rejection,
 * the throttled activity+sliding write (now fires for app tokens too), and revokeById ownership.
 */
describe('SessionTokenService', () => {
  const prisma = {
    sessionToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const insert = vi.fn((table: unknown) => ({
    values: (data: Record<string, unknown>) => ({
      returning: async () => {
        if (table !== sessionToken) return [];
        const created = await prisma.sessionToken.create({ data });
        return created ? [{ id: created.id }] : [];
      },
    }),
  }));
  const select = vi.fn((selection?: Record<string, unknown>) => {
    let table: unknown;
    const resolve = async () => {
      if (table === user) {
        const created = prisma.sessionToken.create.mock.results.at(-1)?.value;
        const row = created
          ? await created
          : { user: { mustChangePassword: false } };
        return [{ mustChangePassword: row.user?.mustChangePassword ?? false }];
      }
      const rows = await prisma.sessionToken.findMany();
      if (rows.length > 0) return rows;
      const row =
        (await prisma.sessionToken.findFirst()) ??
        (await prisma.sessionToken.findUnique());
      if (!row) return [];
      return [
        { ...row, mustChangePassword: row.user?.mustChangePassword ?? false },
      ];
    };
    const query = {
      from: (value: unknown) => {
        table = value;
        return query;
      },
      innerJoin: () => query,
      where: () => query,
      limit: () => ({
        then: (fn: (rows: unknown[]) => unknown) => resolve().then(fn),
      }),
      then: (fn: (rows: unknown[]) => unknown) => resolve().then(fn),
    };
    return query;
  });
  const update = vi.fn(() => {
    const query = {
      set: (data: Record<string, unknown>) => {
        prisma.sessionToken.update({ data });
        return query;
      },
      where: async () => undefined,
    };
    return query;
  });
  const database = { db: { insert, select, update } };
  const kv = {
    get: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
    initPersistent: vi.fn(),
    getPersistent: vi.fn(),
    updatePersistent: vi.fn(),
    delPersistent: vi.fn(),
  };
  const svc = new SessionTokenService(
    database as never,
    kv as unknown as KvStoreService,
  );

  beforeEach(() => {
    prisma.sessionToken.create.mockReset();
    prisma.sessionToken.findUnique.mockReset();
    prisma.sessionToken.findFirst.mockReset();
    prisma.sessionToken.findMany.mockReset();
    prisma.sessionToken.update.mockReset();
    prisma.sessionToken.updateMany.mockReset();
    insert.mockClear();
    select.mockClear();
    update.mockClear();
    kv.get.mockReset();
    kv.setex.mockReset();
    kv.del.mockReset();
    kv.initPersistent.mockReset();
    kv.getPersistent.mockReset();
    kv.updatePersistent.mockReset();
    kv.delPersistent.mockReset();
    // Default Promise returns — the service chains .catch() on every kv + update call, so the mocks
    // must yield Promises (vi.fn() defaults to undefined → .catch on undefined throws).
    prisma.sessionToken.create.mockResolvedValue({
      id: 101,
      user: { mustChangePassword: false },
    });
    prisma.sessionToken.findMany.mockResolvedValue([]);
    prisma.sessionToken.update.mockResolvedValue({});
    prisma.sessionToken.updateMany.mockResolvedValue({ count: 0 });
    kv.get.mockResolvedValue(null); // cache miss by default
    kv.setex.mockResolvedValue(undefined);
    kv.del.mockResolvedValue(0);
    kv.initPersistent.mockResolvedValue(undefined);
    kv.getPersistent.mockResolvedValue(null);
    kv.updatePersistent.mockResolvedValue(true);
    kv.delPersistent.mockResolvedValue(0);
  });

  describe('issue', () => {
    it('uses the default 180-day inactivity deadline for every client', async () => {
      const plaintext = await svc.issue(7, 'app', {
        device: 'pixel',
        ip: '10.0.0.1',
      });
      expect(plaintext).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes hex
      expect(prisma.sessionToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 7,
          client: 'app',
          autoTerminateDays: 30,
          expiresAt: expect.any(Date),
          device: 'pixel',
          ip: '10.0.0.1',
          lastSeenIp: '10.0.0.1',
          tokenHash: expect.any(String),
        }),
      });
      const expiresAt = prisma.sessionToken.create.mock.calls[0][0].data
        .expiresAt as Date;
      expect(expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 29 * 24 * 3600 * 1000,
      );
      expect(kv.initPersistent).toHaveBeenCalledTimes(1);
    });

    it('client metadata does not introduce trusted or persistent lifetime branches', async () => {
      await svc.issue(7, 'web');
      let arg = prisma.sessionToken.create.mock.calls[0][0].data;
      expect(arg.client).toBe('web');
      expect(arg).not.toHaveProperty('trusted');
      expect(arg).not.toHaveProperty('persistent');
      expect(arg.expiresAt).toBeInstanceOf(Date);

      await svc.issue(7, 'desktop');
      arg = prisma.sessionToken.create.mock.calls[1][0].data;
      expect(arg.client).toBe('desktop');
      expect(arg.autoTerminateDays).toBe(30);
    });

    it('stores the sha256 hash, never the plaintext', async () => {
      const plaintext = await svc.issue(7, 'web');
      const stored = prisma.sessionToken.create.mock.calls[0][0].data.tokenHash;
      expect(stored).not.toBe(plaintext);
      expect(stored).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    });
  });

  describe('validate', () => {
    /** Build a plaintext + its DB row shape so findUnique + the hash line up with validate(). */
    function makeRow(
      overrides: Partial<{
        id: number;
        userId: number;
        expiresAt: Date;
        revokedAt: Date | null;
        lastSeenAt: Date;
        autoTerminateDays: 7 | 30 | 90 | 180 | 365;
      }> = {},
    ) {
      return {
        id: 101,
        userId: 7,
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: null,
        lastSeenAt: new Date(),
        autoTerminateDays: 180,
        user: { mustChangePassword: false },
        ...overrides,
      };
    }

    it('validates a cache miss from DB without creating a cache entry', async () => {
      const raw = 'a'.repeat(64);
      prisma.sessionToken.findUnique.mockResolvedValue(makeRow());
      await expect(svc.validate(raw)).resolves.toEqual({
        userId: 7,
        sessionId: 101,
        slid: false,
        autoTerminateDays: 180,
        mustChangePassword: false,
      });
      expect(prisma.sessionToken.findUnique).toHaveBeenCalledTimes(1);
      expect(kv.initPersistent).not.toHaveBeenCalled();
      expect(kv.updatePersistent).not.toHaveBeenCalled();
    });

    it('serves an issued persistent-cache hit without a DB read', async () => {
      kv.getPersistent.mockResolvedValue(
        JSON.stringify({
          userId: 7,
          sessionId: 101,
          exp: Date.now() + 3600_000,
          autoTerminateDays: 180,
          mustChangePassword: false,
          nextTouchAt: Date.now() + 60_000,
        }),
      );
      await expect(svc.validate('a'.repeat(64))).resolves.toEqual({
        userId: 7,
        sessionId: 101,
        slid: false,
        autoTerminateDays: 180,
        mustChangePassword: false,
      });
      expect(prisma.sessionToken.findUnique).not.toHaveBeenCalled();
    });

    it('rejects an expired web token (expiresAt in the past)', async () => {
      prisma.sessionToken.findUnique.mockResolvedValue(
        makeRow({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(svc.validate('c'.repeat(64))).resolves.toBe(null);
    });

    it('rejects a revoked token', async () => {
      prisma.sessionToken.findUnique.mockResolvedValue(
        makeRow({ revokedAt: new Date() }),
      );
      await expect(svc.validate('d'.repeat(64))).resolves.toBe(null);
    });

    it('rejects an unknown token (no row)', async () => {
      prisma.sessionToken.findUnique.mockResolvedValue(null);
      await expect(svc.validate('e'.repeat(64))).resolves.toBe(null);
    });

    it('extends the sliding window (web) + records lastSeenIp + returns slid:true when lastSeenAt is stale', async () => {
      const stale = makeRow({ lastSeenAt: new Date(Date.now() - 10 * 60_000) }); // 10 min ago
      prisma.sessionToken.findUnique.mockResolvedValue(stale);
      kv.getPersistent.mockResolvedValue(
        JSON.stringify({
          userId: 7,
          sessionId: 101,
          exp: stale.expiresAt!.getTime(),
          autoTerminateDays: 180,
          mustChangePassword: false,
          nextTouchAt: Date.now() - 1,
        }),
      );
      const res = await svc.validate('f'.repeat(64), { ip: '203.0.113.7' });
      expect(res?.slid).toBe(true); // deadline moved → the guard re-issues the cookie
      expect(prisma.sessionToken.update).toHaveBeenCalledTimes(1);
      const data = prisma.sessionToken.update.mock.calls[0][0].data;
      expect(data.lastSeenAt).toBeInstanceOf(Date);
      expect(data.lastSeenIp).toBe('203.0.113.7');
      expect(data.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 179 * 24 * 3600 * 1000,
      );
      expect(kv.updatePersistent).toHaveBeenCalledTimes(1);
    });

    it('refreshes lastSeenAt, lastSeenIp and expiresAt for an app token too', async () => {
      const stale = makeRow({
        lastSeenAt: new Date(Date.now() - 10 * 60_000),
      });
      prisma.sessionToken.findUnique.mockResolvedValue(stale);
      await svc.validate('app1'.repeat(16), { ip: '198.51.100.4' });
      expect(prisma.sessionToken.update).toHaveBeenCalledTimes(1);
      const data = prisma.sessionToken.update.mock.calls[0][0].data;
      expect(data.lastSeenAt).toBeInstanceOf(Date);
      expect(data.lastSeenIp).toBe('198.51.100.4');
      expect(data.expiresAt).toBeInstanceOf(Date);
    });

    it('does NOT write when lastSeenAt is recent', async () => {
      prisma.sessionToken.findUnique.mockResolvedValue(
        makeRow({ lastSeenAt: new Date() }),
      );
      await svc.validate('g'.repeat(64));
      expect(prisma.sessionToken.update).not.toHaveBeenCalled();
    });

    it('propagates user.mustChangePassword (drives the global password-rotation gate)', async () => {
      prisma.sessionToken.findUnique.mockResolvedValue(
        makeRow({ user: { mustChangePassword: true } }),
      );
      await expect(svc.validate('p'.repeat(32))).resolves.toEqual(
        expect.objectContaining({
          userId: 7,
          sessionId: 101,
          mustChangePassword: true,
        }),
      );
    });

    it('rejects instead of resurrecting a cache entry deleted during an in-flight touch', async () => {
      const stale = makeRow({ lastSeenAt: new Date(Date.now() - 10 * 60_000) });
      kv.getPersistent
        .mockResolvedValueOnce(
          JSON.stringify({
            userId: 7,
            sessionId: 101,
            exp: stale.expiresAt!.getTime(),
            persistent: true,
            mustChangePassword: false,
            nextTouchAt: Date.now() - 1,
          }),
        )
        .mockResolvedValueOnce(null);
      prisma.sessionToken.findUnique
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(makeRow({ revokedAt: new Date() }));
      kv.updatePersistent.mockResolvedValue(false);

      await expect(svc.validate('race'.repeat(16))).resolves.toBeNull();
      expect(kv.initPersistent).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('soft-revokes the row by hash and clears the cache (idempotent)', async () => {
      prisma.sessionToken.updateMany.mockResolvedValue({ count: 1 });
      await svc.revoke('h'.repeat(64));
      expect(prisma.sessionToken.update).toHaveBeenCalledWith({
        data: { revokedAt: expect.any(Date), revokeReason: 'logout' },
      });
      expect(kv.delPersistent).toHaveBeenCalledTimes(1);
    });
  });

  describe('revokeById', () => {
    it('revokes the row by id (ownership-checked) and drops the cache', async () => {
      prisma.sessionToken.findFirst.mockResolvedValue({ tokenHash: 'abc' });
      const ok = await svc.revokeById(7, 101);
      expect(ok).toBe(true);
      expect(prisma.sessionToken.findFirst).toHaveBeenCalled();
      expect(prisma.sessionToken.update).toHaveBeenCalledWith({
        data: { revokedAt: expect.any(Date), revokeReason: 'device_revoke' },
      });
      expect(kv.delPersistent).toHaveBeenCalledTimes(1);
    });

    it('returns false (no-op) for a foreign / unknown / already-revoked id', async () => {
      prisma.sessionToken.findFirst.mockResolvedValue(null);
      const ok = await svc.revokeById(7, 999);
      expect(ok).toBe(false);
      expect(prisma.sessionToken.update).not.toHaveBeenCalled();
      expect(kv.delPersistent).not.toHaveBeenCalled();
    });

    it('writes the supplied reason instead of the default device_revoke', async () => {
      prisma.sessionToken.findFirst.mockResolvedValue({ tokenHash: 'abc' });
      await svc.revokeById(7, 101, 'admin_revoke');
      expect(prisma.sessionToken.update).toHaveBeenCalledWith({
        data: { revokedAt: expect.any(Date), revokeReason: 'admin_revoke' },
      });
    });
  });

  describe('revokeAllForUser', () => {
    it('revokes every active row for the user with the given reason', async () => {
      prisma.sessionToken.findMany.mockResolvedValue([
        { tokenHash: 'hash-a' },
        { tokenHash: 'hash-b' },
      ]);
      prisma.sessionToken.updateMany.mockResolvedValue({ count: 3 });
      await svc.revokeAllForUser(7, 'password_change');
      expect(prisma.sessionToken.update).toHaveBeenCalledWith({
        data: { revokedAt: expect.any(Date), revokeReason: 'password_change' },
      });
      expect(kv.delPersistent).toHaveBeenCalledWith(
        'session:hash-a',
        'session:hash-b',
      );
    });
  });

  describe('bustCacheBySessionId', () => {
    it('drops the validate-cache entry for the session row (looked up by id)', async () => {
      prisma.sessionToken.findUnique.mockResolvedValue({ tokenHash: 'abc' });
      await svc.bustCacheBySessionId(101);
      expect(prisma.sessionToken.findUnique).toHaveBeenCalled();
      expect(kv.delPersistent).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when the session id is unknown (no cache key to drop)', async () => {
      prisma.sessionToken.findUnique.mockResolvedValue(null);
      await svc.bustCacheBySessionId(999);
      expect(kv.delPersistent).not.toHaveBeenCalled();
    });
  });
});
