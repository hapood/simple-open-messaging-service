import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionTokenService } from './session-token.service.js';
import { account, sessionToken, userPreference } from '../database/schema.js';
import type { KvStoreService } from '../kv-store/kv-store.service.js';

/**
 * SessionTokenService: issue/validate/revoke of the long-lived per-device session credential. Pure
 * unit tests (Drizzle + KV mocked inline) covering the app(no-expiry)/web·desktop(sliding) lifetime
 * policies, client/lastSeenIp persistence, the KV validate cache, revocation/expiry/unknown rejection,
 * the throttled activity+sliding write (now fires for app tokens too), and revokeById ownership.
 */
describe('SessionTokenService', () => {
  const store = {
    sessionToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      updateReturning: vi.fn(),
    },
  };
  const insert = vi.fn((table: unknown) => ({
    values: (data: Record<string, unknown>) => {
      const query = {
        returning: async () => {
          if (table !== sessionToken) return [];
          const created = await store.sessionToken.create({ data });
          return created ? [{ id: created.id }] : [];
        },
        onConflictDoUpdate: async () => undefined,
      };
      return query;
    },
  }));
  const select = vi.fn((selection?: Record<string, unknown>) => {
    void selection;
    let table: unknown;
    const resolve = async () => {
      if (table === account) {
        const created = store.sessionToken.create.mock.results.at(-1)?.value;
        const row = created
          ? await created
          : { user: { mustChangePassword: false } };
        return [{ mustChangePassword: row.user?.mustChangePassword ?? false }];
      }
      if (table === userPreference) return [];
      const rows = await store.sessionToken.findMany();
      if (rows.length > 0) return rows;
      const row =
        (await store.sessionToken.findFirst()) ??
        (await store.sessionToken.findUnique());
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
      for: () => resolve(),
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
        store.sessionToken.update({ data });
        return query;
      },
      where: () => ({
        returning: () => store.sessionToken.updateReturning(),
        then: (
          resolve: (value: undefined) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(undefined).then(resolve, reject),
      }),
    };
    return query;
  });
  const db = { insert, select, update };
  const transaction = vi.fn((callback: (tx: typeof db) => unknown) =>
    callback(db),
  );
  const database = { db: { ...db, transaction } };
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
    store.sessionToken.create.mockReset();
    store.sessionToken.findUnique.mockReset();
    store.sessionToken.findFirst.mockReset();
    store.sessionToken.findMany.mockReset();
    store.sessionToken.update.mockReset();
    store.sessionToken.updateMany.mockReset();
    store.sessionToken.updateReturning.mockReset();
    insert.mockClear();
    select.mockClear();
    update.mockClear();
    transaction.mockClear();
    kv.get.mockReset();
    kv.setex.mockReset();
    kv.del.mockReset();
    kv.initPersistent.mockReset();
    kv.getPersistent.mockReset();
    kv.updatePersistent.mockReset();
    kv.delPersistent.mockReset();
    // Default Promise returns — the service chains .catch() on every kv + update call, so the mocks
    // must yield Promises (vi.fn() defaults to undefined → .catch on undefined throws).
    store.sessionToken.create.mockResolvedValue({
      id: 101,
      user: { mustChangePassword: false },
    });
    store.sessionToken.findMany.mockResolvedValue([]);
    store.sessionToken.update.mockResolvedValue({});
    store.sessionToken.updateMany.mockResolvedValue({ count: 0 });
    store.sessionToken.updateReturning.mockResolvedValue([
      { id: 101, tokenHash: 'abc' },
    ]);
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
      expect(store.sessionToken.create).toHaveBeenCalledWith({
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
      const expiresAt = store.sessionToken.create.mock.calls[0][0].data
        .expiresAt as Date;
      expect(expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 29 * 24 * 3600 * 1000,
      );
      expect(kv.initPersistent).toHaveBeenCalledTimes(1);
    });

    it('client metadata does not introduce trusted or persistent lifetime branches', async () => {
      await svc.issue(7, 'web');
      let arg = store.sessionToken.create.mock.calls[0][0].data;
      expect(arg.client).toBe('web');
      expect(arg).not.toHaveProperty('trusted');
      expect(arg).not.toHaveProperty('persistent');
      expect(arg.expiresAt).toBeInstanceOf(Date);

      await svc.issue(7, 'desktop');
      arg = store.sessionToken.create.mock.calls[1][0].data;
      expect(arg.client).toBe('desktop');
      expect(arg.autoTerminateDays).toBe(30);
    });

    it('initializes the cache before the issuance transaction releases its lock', async () => {
      let inside = false;
      transaction.mockImplementationOnce(async (callback) => {
        inside = true;
        const result = await callback(db);
        expect(kv.initPersistent).toHaveBeenCalledOnce();
        inside = false;
        return result;
      });
      kv.initPersistent.mockImplementationOnce(async () => {
        expect(inside).toBe(true);
      });
      await svc.issue(7, 'web');
    });

    it('removes the initialized cache entry when the transaction commit fails', async () => {
      transaction.mockImplementationOnce(async (callback) => {
        await callback(db);
        throw new Error('commit failed');
      });
      await expect(svc.issue(7, 'web')).rejects.toThrow('commit failed');
      expect(kv.initPersistent).toHaveBeenCalledOnce();
      expect(kv.delPersistent).toHaveBeenCalledWith(
        kv.initPersistent.mock.calls[0][0],
      );
    });

    it('stores the sha256 hash, never the plaintext', async () => {
      const plaintext = await svc.issue(7, 'web');
      const stored = store.sessionToken.create.mock.calls[0][0].data.tokenHash;
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
        /** Not a drizzle column — the fake's account select reads it to build the principal. */
        user: { mustChangePassword: boolean } | null;
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
      store.sessionToken.findUnique.mockResolvedValue(makeRow());
      await expect(svc.validate(raw)).resolves.toEqual({
        userId: 7,
        sessionId: 101,
        slid: false,
        autoTerminateDays: 180,
        mustChangePassword: false,
      });
      expect(store.sessionToken.findUnique).toHaveBeenCalledTimes(1);
      expect(kv.initPersistent).not.toHaveBeenCalled();
      expect(kv.updatePersistent).not.toHaveBeenCalled();
    });

    it('serves a fresh issued cache entry without a database read', async () => {
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
      expect(select).not.toHaveBeenCalled();
    });

    it('does not accept an expired payload even if the cache adapter returns it', async () => {
      kv.getPersistent.mockResolvedValue(
        JSON.stringify({
          userId: 7,
          sessionId: 101,
          exp: Date.now() - 1,
          nextTouchAt: Date.now() + 60_000,
        }),
      );
      await expect(svc.validate('a'.repeat(64))).resolves.toBeNull();
      expect(select).toHaveBeenCalled();
    });

    it('rejects an expired web token (expiresAt in the past)', async () => {
      store.sessionToken.findUnique.mockResolvedValue(
        makeRow({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(svc.validate('c'.repeat(64))).resolves.toBe(null);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(store.sessionToken.update).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pushToken: null,
          pushP256dh: null,
          pushAuth: null,
        }),
      });
    });

    it('rejects a revoked token', async () => {
      store.sessionToken.findUnique.mockResolvedValue(
        makeRow({ revokedAt: new Date() }),
      );
      await expect(svc.validate('d'.repeat(64))).resolves.toBe(null);
    });

    it('rejects an unknown token (no row)', async () => {
      store.sessionToken.findUnique.mockResolvedValue(null);
      await expect(svc.validate('e'.repeat(64))).resolves.toBe(null);
    });

    it('extends the sliding window (web) + records lastSeenIp + returns slid:true when lastSeenAt is stale', async () => {
      const stale = makeRow({ lastSeenAt: new Date(Date.now() - 10 * 60_000) }); // 10 min ago
      store.sessionToken.findUnique.mockResolvedValue(stale);
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
      expect(store.sessionToken.update).toHaveBeenCalledTimes(1);
      const data = store.sessionToken.update.mock.calls[0][0].data;
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
      store.sessionToken.findUnique.mockResolvedValue(stale);
      await svc.validate('app1'.repeat(16), { ip: '198.51.100.4' });
      expect(store.sessionToken.update).toHaveBeenCalledTimes(1);
      const data = store.sessionToken.update.mock.calls[0][0].data;
      expect(data.lastSeenAt).toBeInstanceOf(Date);
      expect(data.lastSeenIp).toBe('198.51.100.4');
      expect(data.expiresAt).toBeInstanceOf(Date);
    });

    it('does NOT write when lastSeenAt is recent', async () => {
      store.sessionToken.findUnique.mockResolvedValue(
        makeRow({ lastSeenAt: new Date() }),
      );
      await svc.validate('g'.repeat(64));
      expect(store.sessionToken.update).not.toHaveBeenCalled();
    });

    it('propagates user.mustChangePassword (drives the global password-rotation gate)', async () => {
      store.sessionToken.findUnique.mockResolvedValue(
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
      store.sessionToken.findUnique
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(makeRow({ revokedAt: new Date() }));
      kv.updatePersistent.mockResolvedValue(false);

      await expect(svc.validate('race'.repeat(16))).resolves.toBeNull();
      expect(kv.initPersistent).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('soft-revokes the row by hash and clears the cache (idempotent)', async () => {
      store.sessionToken.updateMany.mockResolvedValue({ count: 1 });
      await svc.revoke('h'.repeat(64));
      expect(store.sessionToken.update).toHaveBeenCalledWith({
        data: expect.objectContaining({
          revokedAt: expect.any(Date),
          revokeReason: 'logout',
        }),
      });
      expect(store.sessionToken.update).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pushToken: null,
          pushP256dh: null,
          pushAuth: null,
        }),
      });
      expect(kv.delPersistent).toHaveBeenCalledTimes(1);
    });
  });

  describe('revokeById', () => {
    it('revokes the row by id (ownership-checked) and drops the cache', async () => {
      const ok = await svc.revokeById(7, 101);
      expect(ok).toBe(true);
      expect(store.sessionToken.update).toHaveBeenCalledWith({
        data: expect.objectContaining({
          revokedAt: expect.any(Date),
          revokeReason: 'device_revoke',
        }),
      });
      expect(store.sessionToken.update).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pushToken: null,
          pushP256dh: null,
          pushAuth: null,
        }),
      });
      expect(kv.delPersistent).toHaveBeenCalledTimes(1);
    });

    it('returns false (no-op) for a foreign / unknown / already-revoked id', async () => {
      store.sessionToken.updateReturning.mockResolvedValue([]);
      const ok = await svc.revokeById(7, 999);
      expect(ok).toBe(false);
      expect(store.sessionToken.update).toHaveBeenCalledTimes(1);

      expect(kv.delPersistent).not.toHaveBeenCalled();
    });

    it('writes the supplied reason instead of the default device_revoke', async () => {
      await svc.revokeById(7, 101, 'admin_revoke');
      expect(store.sessionToken.update).toHaveBeenCalledWith({
        data: expect.objectContaining({
          revokedAt: expect.any(Date),
          revokeReason: 'admin_revoke',
        }),
      });
    });
  });

  describe('revokeAllForUser', () => {
    it('revokes every active row for the user with the given reason', async () => {
      store.sessionToken.findMany.mockResolvedValue([
        { tokenHash: 'hash-a' },
        { tokenHash: 'hash-b' },
      ]);
      store.sessionToken.updateReturning.mockResolvedValue([
        { id: 101, tokenHash: 'hash-a' },
        { id: 102, tokenHash: 'hash-b' },
      ]);
      await svc.revokeAllForUser(7, 'password_change');
      expect(store.sessionToken.update).toHaveBeenCalledWith({
        data: expect.objectContaining({
          revokedAt: expect.any(Date),
          revokeReason: 'password_change',
        }),
      });
      expect(store.sessionToken.update).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pushToken: null,
          pushP256dh: null,
          pushAuth: null,
        }),
      });
      expect(kv.delPersistent).toHaveBeenCalledWith(
        'session:hash-a',
        'session:hash-b',
      );
    });
  });

  describe('setAutoTerminateDays', () => {
    it('removes Push registrations for sessions made expired by the new policy', async () => {
      store.sessionToken.findMany.mockResolvedValue([{ tokenHash: 'hash-a' }]);

      await svc.setAutoTerminateDays(7, 7);

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(store.sessionToken.update).toHaveBeenCalledWith({
        data: {
          autoTerminateDays: 7,
          expiresAt: expect.anything(),
        },
      });
      expect(store.sessionToken.update).toHaveBeenCalledWith({
        data: expect.objectContaining({
          revokedAt: expect.any(Date),
          revokeReason: 'auto_terminated',
        }),
      });
      expect(store.sessionToken.update).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pushToken: null,
          pushP256dh: null,
          pushAuth: null,
        }),
      });
    });
  });

  describe('bustCacheBySessionId', () => {
    it('drops the validate-cache entry for the session row (looked up by id)', async () => {
      store.sessionToken.findUnique.mockResolvedValue({ tokenHash: 'abc' });
      await svc.bustCacheBySessionId(101);
      expect(store.sessionToken.findUnique).toHaveBeenCalled();
      expect(kv.delPersistent).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when the session id is unknown (no cache key to drop)', async () => {
      store.sessionToken.findUnique.mockResolvedValue(null);
      await svc.bustCacheBySessionId(999);
      expect(kv.delPersistent).not.toHaveBeenCalled();
    });
  });
});
