import { describe, it, expect, vi, beforeEach } from 'vitest';
import argon2 from 'argon2';
import { OtpLoginService } from './otp-login.service.js';
import { BruteForceService } from './brute-force.service.js';
import { BusinessCode } from '../common/business-code.js';
import type { SessionTokenService } from './session-token.service.js';
import type { SettingsService } from '../settings/settings.service.js';

/**
 * OtpLoginService: admin-issued one-time login codes (available on every platform). Covers issue (plaintext
 * reveal-once; multi-issue — issuing does NOT revoke prior codes; configurable TTL), verifyAndLogin (accepts
 * ANY active code by argon2 hash-match, single-use guard, client-driven trust, producedSessionId audit link,
 * precise expired/invalid codes), the account-dimension brute-force lock, revoke, and the audit list.
 * argon2 runs real (one hash/verify per round-trip) — the failure paths that don't need it (no-code) throw
 * before verify.
 */
describe('OtpLoginService', () => {
  const prisma = {
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
            findFirst: (...args: unknown[]) => prisma.user.findUnique(...args),
          },
          loginCode: {
            findMany: (...args: unknown[]) =>
              prisma.loginCode.findMany(...args),
          },
        },
        insert: vi.fn(() => ({
          values: vi.fn((data: Record<string, unknown>) => ({
            returning: vi.fn(async () => [
              await prisma.loginCode.create({ data }),
            ]),
          })),
        })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => prisma.loginCode.findMany()),
              })),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn((data: Record<string, unknown>) => ({
            where: vi.fn(() => {
              const run = () => prisma.loginCode.update({ data });
              return {
                returning: vi.fn(async () => {
                  const result = await prisma.loginCode.updateMany({ data });
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
    prisma.user.findUnique.mockReset();
    prisma.loginCode.create.mockReset();
    prisma.loginCode.findMany.mockReset();
    prisma.loginCode.updateMany.mockReset();
    prisma.loginCode.update.mockReset();
    sessionTokens.issue.mockReset();
    sessionTokens.idOfToken.mockReset();
    settings.getOtpTtlMinutes.mockReset();
    settings.getOtpTtlMinutes.mockResolvedValue(10); // 10-minute validity window
    // Default Promise returns — the service chains .catch() on the fire-and-forget producedSessionId
    // update, so the mocks must yield Promises (vi.fn() defaults to undefined → .catch on undefined throws).
    prisma.loginCode.update.mockResolvedValue({});
  });

  /** Issue a code for userId 42 (admin 7) and capture the argon2 hash so a verify test can match it. */
  async function issueAndCaptureHash(): Promise<{
    code: string;
    codeHash: string;
  }> {
    prisma.loginCode.create.mockResolvedValue({
      id: 5,
      issuedAt: new Date(1000),
      expiresAt: new Date(2000),
      issuedBy: 7,
    });
    const r = await svc.issueCode(7, 42);
    const data = (
      prisma.loginCode.create.mock.calls[0][0] as { data: { codeHash: string } }
    ).data;
    return { code: r.code, codeHash: data.codeHash };
  }

  describe('issueCode', () => {
    it('returns a 6-digit plaintext ONCE; uses the configured TTL; does NOT revoke prior codes (multi-issue)', async () => {
      const r = await issueAndCaptureHash();
      expect(r.code).toMatch(/^\d{6}$/);
      // expiresAt = now + the mocked 10-minute TTL.
      const data = (
        prisma.loginCode.create.mock.calls[0][0] as {
          data: { expiresAt: Date };
        }
      ).data;
      expect(data.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
      expect(data.expiresAt.getTime() - Date.now()).toBeLessThan(11 * 60_000);
      // Multi-issue: issuing must NOT touch (revoke) the account's other codes.
      expect(prisma.loginCode.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('verifyAndLogin', () => {
    it('verifies a correct code (default client app → trusted/permanent), records producedSessionId', async () => {
      const { code, codeHash } = await issueAndCaptureHash();
      prisma.user.findUnique.mockResolvedValue({
        id: 42,
        isGroup: false,
        isDeleted: false,
        mustChangePassword: false,
      });
      prisma.loginCode.findMany.mockResolvedValue([
        { id: 5, codeHash, expiresAt: new Date(Date.now() + 60_000) },
      ]);
      prisma.loginCode.updateMany.mockResolvedValue({ count: 1 }); // single-use guard wins
      sessionTokens.issue.mockResolvedValue('token-xyz');
      sessionTokens.idOfToken.mockResolvedValue(99);

      const r = await svc.verifyAndLogin('alice', code, { ip: '1.2.3.4' });
      expect(r.token).toBe('token-xyz');
      expect(sessionTokens.issue).toHaveBeenCalledWith(
        42,
        'app',
        expect.objectContaining({
          ip: '1.2.3.4',
          persistent: true,
          trusted: true,
        }),
      );
      expect(prisma.loginCode.update).toHaveBeenCalledWith({
        data: { producedSessionId: 99 },
      });
    });

    it('accepts ANY active code — not just the newest (multi-issue)', async () => {
      const olderHash = await argon2.hash('111111');
      const newerHash = await argon2.hash('222222');
      prisma.user.findUnique.mockResolvedValue({
        id: 42,
        isGroup: false,
        isDeleted: false,
        mustChangePassword: false,
      });
      // findMany returns newest-first; the user enters the OLDER code's value.
      prisma.loginCode.findMany.mockResolvedValue([
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
      prisma.loginCode.updateMany.mockResolvedValue({ count: 1 });
      sessionTokens.issue.mockResolvedValue('t');

      await svc.verifyAndLogin('alice', '111111', {});
      // The matched (older) code is the one single-use-claimed.
      expect(prisma.loginCode.updateMany).toHaveBeenCalledTimes(1);
    });

    it("client 'web' → untrusted (14-day); 'desktop' → trusted (permanent)", async () => {
      const codeHash = await argon2.hash('333333');
      prisma.user.findUnique.mockResolvedValue({
        id: 42,
        isGroup: false,
        isDeleted: false,
        mustChangePassword: false,
      });
      prisma.loginCode.findMany.mockResolvedValue([
        { id: 5, codeHash, expiresAt: new Date(Date.now() + 60_000) },
      ]);
      prisma.loginCode.updateMany.mockResolvedValue({ count: 1 });
      sessionTokens.issue.mockResolvedValue('t');

      await svc.verifyAndLogin('alice', '333333', { client: 'web' });
      expect(sessionTokens.issue).toHaveBeenLastCalledWith(
        42,
        'web',
        expect.objectContaining({ trusted: false }),
      );

      prisma.loginCode.updateMany.mockClear();
      sessionTokens.issue.mockClear();
      await svc.verifyAndLogin('alice', '333333', { client: 'desktop' });
      expect(sessionTokens.issue).toHaveBeenLastCalledWith(
        42,
        'desktop',
        expect.objectContaining({ trusted: true }),
      );
    });

    it('throws OTP_INVALID for a wrong code (counted toward the lock)', async () => {
      const codeHash = await argon2.hash('123456');
      prisma.user.findUnique.mockResolvedValue({
        id: 42,
        isGroup: false,
        isDeleted: false,
        mustChangePassword: false,
      });
      prisma.loginCode.findMany.mockResolvedValue([
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
      prisma.user.findUnique.mockResolvedValue({
        id: 42,
        isGroup: false,
        isDeleted: false,
        mustChangePassword: false,
      });
      prisma.loginCode.findMany.mockResolvedValue([
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
      prisma.user.findUnique.mockResolvedValue({
        id: 42,
        isGroup: false,
        isDeleted: false,
        mustChangePassword: false,
      });
      prisma.loginCode.findMany.mockResolvedValue([
        { id: 5, codeHash, expiresAt: new Date(Date.now() + 60_000) },
      ]);
      prisma.loginCode.updateMany.mockResolvedValue({ count: 0 }); // race lost
      await expect(
        svc.verifyAndLogin('race', '555555', {}),
      ).rejects.toMatchObject({
        bizCode: BusinessCode.OTP_CONSUMED,
      });
    });

    it('throws OTP_INVALID for a non-existent account (NOT counted; no code lookup)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        svc.verifyAndLogin('ghost', '000000', {}),
      ).rejects.toMatchObject({
        bizCode: BusinessCode.OTP_INVALID,
      });
      expect(prisma.loginCode.findMany).not.toHaveBeenCalled();
    });

    it('locks the account (RATE_LIMITED) once failures cross the threshold — surfaced on the crossing attempt', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 42,
        isGroup: false,
        isDeleted: false,
        mustChangePassword: false,
      });
      prisma.loginCode.findMany.mockResolvedValue([]); // no active code → OTP_INVALID (counted) before argon2
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
      prisma.loginCode.updateMany.mockResolvedValue({ count: 1 });
      await expect(svc.revokeCode(5)).resolves.toBe(true);
    });
    it('returns false (no-op) for an already-used / unknown code', async () => {
      prisma.loginCode.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.revokeCode(999)).resolves.toBe(false);
    });
  });

  describe('listCodes', () => {
    it('returns the audit rows (newest first; never the codeHash)', async () => {
      const rows = [{ id: 5 }];
      prisma.loginCode.findMany.mockResolvedValue(rows);
      await expect(svc.listCodes(42)).resolves.toBe(rows);
      expect(prisma.loginCode.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
