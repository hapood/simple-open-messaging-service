import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionTokenService } from './session-token.service.js';
import type { PrismaService } from '../prisma.service.js';
import type { KvStoreService } from '../kv-store/kv-store.service.js';

/**
 * SessionTokenService: issue/validate/revoke of the long-lived per-device session credential. Pure
 * unit tests (Prisma + KV mocked inline) covering the app(no-expiry)/web·desktop(sliding) lifetime
 * policies, client/lastSeenIp persistence, the KV validate cache, revocation/expiry/unknown rejection,
 * the throttled activity+sliding write (now fires for app tokens too), and revokeById ownership.
 */
describe('SessionTokenService', () => {
  const prisma = {
    sessionToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const kv = {
    get: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
  };
  const svc = new SessionTokenService(
    prisma as unknown as PrismaService,
    kv as unknown as KvStoreService,
  );

  beforeEach(() => {
    prisma.sessionToken.create.mockReset();
    prisma.sessionToken.findUnique.mockReset();
    prisma.sessionToken.findFirst.mockReset();
    prisma.sessionToken.update.mockReset();
    prisma.sessionToken.updateMany.mockReset();
    kv.get.mockReset();
    kv.setex.mockReset();
    kv.del.mockReset();
    // Default Promise returns — the service chains .catch() on every kv + update call, so the mocks
    // must yield Promises (vi.fn() defaults to undefined → .catch on undefined throws).
    prisma.sessionToken.create.mockResolvedValue({});
    prisma.sessionToken.update.mockResolvedValue({});
    prisma.sessionToken.updateMany.mockResolvedValue({ count: 0 });
    kv.get.mockResolvedValue(null); // cache miss by default
    kv.setex.mockResolvedValue(undefined);
    kv.del.mockResolvedValue(0);
  });

  describe('issue', () => {
    it("app client → client persisted + expiresAt null (no lifecycle)", async () => {
      const plaintext = await svc.issue(7, 'app', { device: 'pixel', ip: '10.0.0.1' });
      expect(plaintext).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes hex
      expect(prisma.sessionToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 7,
          client: 'app',
          expiresAt: null,
          device: 'pixel',
          ip: '10.0.0.1',
          lastSeenIp: '10.0.0.1',
          tokenHash: expect.any(String),
        }),
      });
    });

    it('web/desktop client → expiresAt ~30d out (sliding) + client persisted', async () => {
      await svc.issue(7, 'web');
      let arg = prisma.sessionToken.create.mock.calls[0][0].data;
      expect(arg.client).toBe('web');
      expect(arg.expiresAt).toBeInstanceOf(Date);
      expect(arg.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);

      await svc.issue(7, 'desktop');
      arg = prisma.sessionToken.create.mock.calls[1][0].data;
      expect(arg.client).toBe('desktop');
      expect(arg.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
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
        expiresAt: Date | null;
        revokedAt: Date | null;
        lastSeenAt: Date;
      }> = {},
    ) {
      return {
        id: 101,
        userId: 7,
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: null,
        lastSeenAt: new Date(),
        ...overrides,
      };
    }

    it('returns { userId, sessionId } for a valid web token and caches the result', async () => {
      const raw = 'a'.repeat(64);
      prisma.sessionToken.findUnique.mockResolvedValue(makeRow());
      // First call: cache miss → DB read + cache write.
      await expect(svc.validate(raw)).resolves.toEqual({ userId: 7, sessionId: 101 });
      expect(prisma.sessionToken.findUnique).toHaveBeenCalledTimes(1);
      expect(kv.setex).toHaveBeenCalledTimes(1);
      // Second call: cache hit (with sessionId in the cached shape) → no DB read.
      kv.get.mockResolvedValue(
        JSON.stringify({ userId: 7, sessionId: 101, exp: Date.now() + 3600_000 }),
      );
      await expect(svc.validate(raw)).resolves.toEqual({ userId: 7, sessionId: 101 });
      expect(prisma.sessionToken.findUnique).toHaveBeenCalledTimes(1); // still once
    });

    it('treats a stale pre-upgrade cache entry (no sessionId) as a miss', async () => {
      kv.get.mockResolvedValue(JSON.stringify({ userId: 7, exp: Date.now() + 3600_000 }));
      prisma.sessionToken.findUnique.mockResolvedValue(makeRow());
      await svc.validate('a2'.repeat(32));
      expect(prisma.sessionToken.findUnique).toHaveBeenCalledTimes(1); // fell through to DB
    });

    it('app token (expiresAt null) never expires', async () => {
      prisma.sessionToken.findUnique.mockResolvedValue(makeRow({ expiresAt: null }));
      await expect(svc.validate('b'.repeat(64))).resolves.toEqual({ userId: 7, sessionId: 101 });
    });

    it('rejects an expired web token (expiresAt in the past)', async () => {
      prisma.sessionToken.findUnique.mockResolvedValue(
        makeRow({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(svc.validate('c'.repeat(64))).resolves.toBe(null);
    });

    it('rejects a revoked token', async () => {
      prisma.sessionToken.findUnique.mockResolvedValue(makeRow({ revokedAt: new Date() }));
      await expect(svc.validate('d'.repeat(64))).resolves.toBe(null);
    });

    it('rejects an unknown token (no row)', async () => {
      prisma.sessionToken.findUnique.mockResolvedValue(null);
      await expect(svc.validate('e'.repeat(64))).resolves.toBe(null);
    });

    it('extends the sliding window (web) + records lastSeenIp when lastSeenAt is stale', async () => {
      const stale = makeRow({ lastSeenAt: new Date(Date.now() - 10 * 60_000) }); // 10 min ago
      prisma.sessionToken.findUnique.mockResolvedValue(stale);
      await svc.validate('f'.repeat(64), { ip: '203.0.113.7' });
      expect(prisma.sessionToken.update).toHaveBeenCalledTimes(1);
      const data = prisma.sessionToken.update.mock.calls[0][0].data;
      expect(data.lastSeenAt).toBeInstanceOf(Date);
      expect(data.lastSeenIp).toBe('203.0.113.7');
      expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
    });

    it('refreshes lastSeenAt/lastSeenIp for an APP token too (no expiresAt in the write)', async () => {
      // Regression: the activity write used to be gated on exp !== null, so app tokens never refreshed
      // lastSeenAt — the device list showed them frozen at sign-in. Now every client refreshes.
      const stale = makeRow({ expiresAt: null, lastSeenAt: new Date(Date.now() - 10 * 60_000) });
      prisma.sessionToken.findUnique.mockResolvedValue(stale);
      await svc.validate('app1'.repeat(16), { ip: '198.51.100.4' });
      expect(prisma.sessionToken.update).toHaveBeenCalledTimes(1);
      const data = prisma.sessionToken.update.mock.calls[0][0].data;
      expect(data.lastSeenAt).toBeInstanceOf(Date);
      expect(data.lastSeenIp).toBe('198.51.100.4');
      expect(data.expiresAt).toBeUndefined(); // app token: deadline not touched
    });

    it('does NOT write when lastSeenAt is recent', async () => {
      prisma.sessionToken.findUnique.mockResolvedValue(makeRow({ lastSeenAt: new Date() }));
      await svc.validate('g'.repeat(64));
      expect(prisma.sessionToken.update).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('soft-revokes the row by hash and clears the cache (idempotent)', async () => {
      prisma.sessionToken.updateMany.mockResolvedValue({ count: 1 });
      await svc.revoke('h'.repeat(64));
      expect(prisma.sessionToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: expect.any(String), revokedAt: null },
        data: { revokedAt: expect.any(Date), revokeReason: 'logout' },
      });
      expect(kv.del).toHaveBeenCalledTimes(1);
    });
  });

  describe('revokeById', () => {
    it('revokes the row by id (ownership-checked) and drops the cache', async () => {
      prisma.sessionToken.findFirst.mockResolvedValue({ tokenHash: 'abc' });
      const ok = await svc.revokeById(7, 101);
      expect(ok).toBe(true);
      expect(prisma.sessionToken.findFirst).toHaveBeenCalledWith({
        where: { id: 101, userId: 7, revokedAt: null },
        select: { tokenHash: true },
      });
      expect(prisma.sessionToken.update).toHaveBeenCalledWith({
        where: { id: 101 },
        data: { revokedAt: expect.any(Date), revokeReason: 'device_revoke' },
      });
      expect(kv.del).toHaveBeenCalledTimes(1);
    });

    it('returns false (no-op) for a foreign / unknown / already-revoked id', async () => {
      prisma.sessionToken.findFirst.mockResolvedValue(null);
      const ok = await svc.revokeById(7, 999);
      expect(ok).toBe(false);
      expect(prisma.sessionToken.update).not.toHaveBeenCalled();
      expect(kv.del).not.toHaveBeenCalled();
    });
  });

  describe('revokeAllForUser', () => {
    it('revokes every active row for the user with the given reason', async () => {
      prisma.sessionToken.updateMany.mockResolvedValue({ count: 3 });
      await svc.revokeAllForUser(7, 'password_change');
      expect(prisma.sessionToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 7, revokedAt: null },
        data: { revokedAt: expect.any(Date), revokeReason: 'password_change' },
      });
    });
  });
});
