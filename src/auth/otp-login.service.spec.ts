import { describe, it, expect, vi, beforeEach } from 'vitest';
import argon2 from 'argon2';
import { OtpLoginService } from './otp-login.service.js';
import { BruteForceService } from './brute-force.service.js';
import { BusinessCode } from '../common/business-code.js';
import type { SessionTokenService } from './session-token.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { loginCode } from '../database/schema.js';

// Service-unit tests exercise OTP selection, expiry, single-use and throttling semantics. Real Argon2
// interoperability is covered by the password hasher and PostgreSQL-backed OTP E2E suites; running many
// native Argon2 jobs inside Vitest's already-parallel unit pool multiplies worker/thread concurrency and
// makes unrelated assertions depend on host CPU availability.
vi.mock('argon2', () => ({
  default: {
    hash: vi.fn(async (plain: string) => `$otp-test$${plain}`),
    verify: vi.fn(
      async (encoded: string, plain: string) =>
        encoded === `$otp-test$${plain}`,
    ),
  },
}));

/**
 * OtpLoginService: admin-issued one-time login codes (available on every platform). Covers issue (plaintext
 * reveal-once; multi-issue — issuing does NOT revoke prior codes; configurable TTL), verifyAndLogin (accepts
 * ANY active code by argon2 hash-match, single-use guard, client-driven trust, producedSessionId audit link,
 * precise expired/invalid codes), the account-dimension brute-force lock, revoke, and the audit list.
 * Argon2 is represented by a deterministic async test double here so the full unit pool does not contend
 * for native hashing workers; cryptographic round-trips remain covered by dedicated integration tests.
 */
describe('OtpLoginService', () => {
  const store = {
    user: { findUnique: vi.fn() },
    loginCode: {
      create: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
  };
  const sessionTokens = { issue: vi.fn(), idOfToken: vi.fn() };
  const settings = { getOtpTtlMinutes: vi.fn() };
  // A REAL BruteForceService drives the account-dimension throttle end-to-end (no mock) — so the lock test
  // exercises the shared engine OtpLoginService delegates to, not a stub. Built fresh per test so a ban
  // recorded in one case can't leak into another (each test gets isolated throttle state).
  let svc: OtpLoginService;

  function databaseFake() {
    return {
      db: {
        query: {
          user: {
            findFirst: (...args: unknown[]) => store.user.findUnique(...args),
          },
          loginCode: {
            findMany: (...args: unknown[]) => store.loginCode.findMany(...args),
          },
        },
        insert: vi.fn(() => ({
          values: vi.fn((data: Record<string, unknown>) => ({
            returning: vi.fn(async () => [
              await store.loginCode.create({ data }),
            ]),
          })),
        })),
        select: vi.fn(() => ({
          from: vi.fn((table: unknown) => {
            const query = {
              innerJoin: () => query,
              where: () => query,
              orderBy: () => query,
              limit: async () =>
                table === loginCode
                  ? store.loginCode.findMany()
                  : await store.user.findUnique().then((row) =>
                      row
                        ? [
                            {
                              availability: 'ACTIVE',
                              disabledAt: null,
                              mustChangePassword: false,
                              ...row,
                            },
                          ]
                        : [],
                    ),
              then: (
                resolve: (value: unknown) => unknown,
                reject: (reason: unknown) => unknown,
              ) => store.loginCode.findMany().then(resolve, reject),
            };
            return query;
          }),
        })),
        update: vi.fn(() => ({
          set: vi.fn((data: Record<string, unknown>) => ({
            where: vi.fn(() => {
              const run = () => store.loginCode.update({ data });
              return {
                returning: vi.fn(async () => {
                  const result = await store.loginCode.updateMany({ data });
                  return Array.from({ length: result.count }, (_, id) => ({
                    id,
                  }));
                }),
                then: (
                  resolve: (value: unknown) => unknown,
                  reject: (reason: unknown) => unknown,
                ) => run().then(resolve, reject),
                catch: (reject: (reason: unknown) => unknown) =>
                  run().catch(reject),
              };
            }),
          })),
        })),
      },
    };
  }

  beforeEach(() => {
    svc = new OtpLoginService(
      databaseFake() as never,
      sessionTokens as unknown as SessionTokenService,
      new BruteForceService(),
      settings as unknown as SettingsService,
    );
    store.user.findUnique.mockReset();
    store.loginCode.create.mockReset();
    store.loginCode.findMany.mockReset();
    store.loginCode.updateMany.mockReset();
    store.loginCode.update.mockReset();
    sessionTokens.issue.mockReset();
    sessionTokens.idOfToken.mockReset();
    settings.getOtpTtlMinutes.mockReset();
    settings.getOtpTtlMinutes.mockResolvedValue(10); // 10-minute validity window
    store.user.findUnique.mockResolvedValue({
      id: 42,
      availability: 'ACTIVE',
      disabledAt: null,
      mustChangePassword: false,
    });
    vi.mocked(argon2.hash).mockClear();
    // Default Promise returns — the service chains .catch() on the fire-and-forget producedSessionId
    // update, so the mocks must yield Promises (vi.fn() defaults to undefined → .catch on undefined throws).
    store.loginCode.update.mockResolvedValue({});
  });

  /** Issue a code for userId 42 (admin 7) and capture the argon2 hash so a verify test can match it. */
  async function issueAndCaptureHash(): Promise<{
    code: string;
    codeHash: string;
  }> {
    store.loginCode.create.mockResolvedValue({
      id: 5,
      issuedAt: new Date(1000),
      expiresAt: new Date(2000),
      issuedBy: 7,
    });
    const r = await svc.issueCode(7, 42);
    const data = (
      store.loginCode.create.mock.calls[0][0] as { data: { codeHash: string } }
    ).data;
    return { code: r.code, codeHash: data.codeHash };
  }

  describe('issueCode', () => {
    it('returns a 6-digit plaintext ONCE; uses the configured TTL; does NOT revoke prior codes (multi-issue)', async () => {
      const r = await issueAndCaptureHash();
      expect(r.code).toMatch(/^\d{6}$/);
      // expiresAt = now + the mocked 10-minute TTL.
      const data = (
        store.loginCode.create.mock.calls[0][0] as {
          data: { issuedAt: Date; expiresAt: Date };
        }
      ).data;
      expect(data.expiresAt.getTime() - data.issuedAt.getTime()).toBe(
        10 * 60_000,
      );
      expect(data.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
      expect(data.expiresAt.getTime() - Date.now()).toBeLessThan(11 * 60_000);
      // Multi-issue: issuing must NOT touch (revoke) the account's other codes.
      expect(store.loginCode.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a federated user stub before hashing or inserting a code', async () => {
      store.user.findUnique.mockResolvedValue(null);

      await expect(svc.issueCode(7, 42)).rejects.toMatchObject({
        bizCode: BusinessCode.NOT_FOUND,
      });
      expect(argon2.hash).not.toHaveBeenCalled();
      expect(store.loginCode.create).not.toHaveBeenCalled();
    });
  });

  describe('verifyAndLogin', () => {
    it('verifies a correct code with the default app client and records producedSessionId', async () => {
      const { code, codeHash } = await issueAndCaptureHash();
      store.user.findUnique.mockResolvedValue({
        id: 42,
        isGroup: false,
        isDeleted: false,
        mustChangePassword: false,
      });
      store.loginCode.findMany.mockResolvedValue([
        { id: 5, codeHash, expiresAt: new Date(Date.now() + 60_000) },
      ]);
      store.loginCode.updateMany.mockResolvedValue({ count: 1 }); // single-use guard wins
      sessionTokens.issue.mockResolvedValue('token-xyz');
      sessionTokens.idOfToken.mockResolvedValue(99);

      const r = await svc.verifyAndLogin('alice', code, { ip: '1.2.3.4' });
      expect(r.token).toBe('token-xyz');
      expect(sessionTokens.issue).toHaveBeenCalledWith(
        42,
        'app',
        expect.objectContaining({
          ip: '1.2.3.4',
        }),
      );
      expect(store.loginCode.update).toHaveBeenCalledWith({
        data: { producedSessionId: 99 },
      });
    });

    it('accepts ANY active code — not just the newest (multi-issue)', async () => {
      const olderHash = await argon2.hash('111111');
      const newerHash = await argon2.hash('222222');
      store.user.findUnique.mockResolvedValue({
        id: 42,
        isGroup: false,
        isDeleted: false,
        mustChangePassword: false,
      });
      // findMany returns newest-first; the user enters the OLDER code's value.
      store.loginCode.findMany.mockResolvedValue([
        {
          id: 9,
          codeHash: newerHash,
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          id: 5,
          codeHash: olderHash,
          expiresAt: new Date(Date.now() + 60_000),
        },
      ]);
      store.loginCode.updateMany.mockResolvedValue({ count: 1 });
      sessionTokens.issue.mockResolvedValue('t');

      await svc.verifyAndLogin('alice', '111111', {});
      // The matched (older) code is the one single-use-claimed.
      expect(store.loginCode.updateMany).toHaveBeenCalledTimes(1);
    }, 15_000);

    it('passes client metadata without lifetime overrides', async () => {
      const codeHash = await argon2.hash('333333');
      store.user.findUnique.mockResolvedValue({
        id: 42,
        isGroup: false,
        isDeleted: false,
        mustChangePassword: false,
      });
      store.loginCode.findMany.mockResolvedValue([
        { id: 5, codeHash, expiresAt: new Date(Date.now() + 60_000) },
      ]);
      store.loginCode.updateMany.mockResolvedValue({ count: 1 });
      sessionTokens.issue.mockResolvedValue('t');

      await svc.verifyAndLogin('alice', '333333', { client: 'web' });
      expect(sessionTokens.issue).toHaveBeenLastCalledWith(
        42,
        'web',
        expect.not.objectContaining({ trusted: expect.anything() }),
      );

      store.loginCode.updateMany.mockClear();
      sessionTokens.issue.mockClear();
      await svc.verifyAndLogin('alice', '333333', { client: 'desktop' });
      expect(sessionTokens.issue).toHaveBeenLastCalledWith(
        42,
        'desktop',
        expect.not.objectContaining({ trusted: expect.anything() }),
      );
    }, 15_000);

    it('throws OTP_INVALID for a wrong code (counted toward the lock)', async () => {
      const codeHash = await argon2.hash('123456');
      store.user.findUnique.mockResolvedValue({
        id: 42,
        isGroup: false,
        isDeleted: false,
        mustChangePassword: false,
      });
      store.loginCode.findMany.mockResolvedValue([
        { id: 5, codeHash, expiresAt: new Date(Date.now() + 60_000) },
      ]);
      await expect(
        svc.verifyAndLogin('wcode', '000000', {}),
      ).rejects.toMatchObject({
        bizCode: BusinessCode.OTP_INVALID,
      });
    });

    it('throws OTP_EXPIRED when the matching code is past its expiresAt', async () => {
      const codeHash = await argon2.hash('444444'); // matches the entered value, but expired
      store.user.findUnique.mockResolvedValue({
        id: 42,
        isGroup: false,
        isDeleted: false,
        mustChangePassword: false,
      });
      store.loginCode.findMany.mockResolvedValue([
        { id: 5, codeHash, expiresAt: new Date(Date.now() - 1000) },
      ]);
      await expect(
        svc.verifyAndLogin('exp', '444444', {}),
      ).rejects.toMatchObject({
        bizCode: BusinessCode.OTP_EXPIRED,
      });
    });

    it('throws OTP_CONSUMED when the single-use race is lost (another verifier claimed it)', async () => {
      const codeHash = await argon2.hash('555555');
      store.user.findUnique.mockResolvedValue({
        id: 42,
        isGroup: false,
        isDeleted: false,
        mustChangePassword: false,
      });
      store.loginCode.findMany.mockResolvedValue([
        { id: 5, codeHash, expiresAt: new Date(Date.now() + 60_000) },
      ]);
      store.loginCode.updateMany.mockResolvedValue({ count: 0 }); // race lost
      await expect(
        svc.verifyAndLogin('race', '555555', {}),
      ).rejects.toMatchObject({
        bizCode: BusinessCode.OTP_CONSUMED,
      });
    });

    it('throws OTP_INVALID for a non-existent account (NOT counted; no code lookup)', async () => {
      store.user.findUnique.mockResolvedValue(null);
      await expect(
        svc.verifyAndLogin('ghost', '000000', {}),
      ).rejects.toMatchObject({
        bizCode: BusinessCode.OTP_INVALID,
      });
      expect(store.loginCode.findMany).not.toHaveBeenCalled();
    });

    it('locks the account (RATE_LIMITED) once failures cross the threshold — surfaced on the crossing attempt', async () => {
      store.user.findUnique.mockResolvedValue({
        id: 42,
        isGroup: false,
        isDeleted: false,
        mustChangePassword: false,
      });
      store.loginCode.findMany.mockResolvedValue([]); // no active code → OTP_INVALID (counted) before argon2
      // Attempts 1–5: each OTP_INVALID (count 1..5; the tier bans past 5, so none bans yet).
      for (let i = 0; i < 5; i++) {
        await expect(
          svc.verifyAndLogin('lockme', '000000', {}),
        ).rejects.toMatchObject({
          bizCode: BusinessCode.OTP_INVALID,
        });
      }
      // 6th: crosses the threshold → failOtp surfaces RATE_LIMITED (with bannedUntil) on THIS attempt.
      await expect(
        svc.verifyAndLogin('lockme', '000000', {}),
      ).rejects.toMatchObject({
        bizCode: BusinessCode.RATE_LIMITED,
      });
    });
  });

  describe('revokeCode', () => {
    it('returns true when a row is actually revoked', async () => {
      store.loginCode.updateMany.mockResolvedValue({ count: 1 });
      await expect(svc.revokeCode(5)).resolves.toBe(true);
    });
    it('returns false (no-op) for an already-used / unknown code', async () => {
      store.loginCode.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.revokeCode(999)).resolves.toBe(false);
    });
  });

  describe('listCodes', () => {
    it('returns the audit rows (newest first; never the codeHash)', async () => {
      const rows = [{ id: 5 }];
      store.loginCode.findMany.mockResolvedValue(rows);
      await expect(svc.listCodes(42)).resolves.toBe(rows);
      expect(store.loginCode.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
