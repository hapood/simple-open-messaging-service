import { describe, it, expect, vi, beforeEach } from 'vitest';
import argon2 from 'argon2';
import { OtpLoginService } from './otp-login.service.js';
import { BruteForceService } from './brute-force.service.js';
import { BusinessCode } from '../common/business-code.js';
import type { PrismaService } from '../prisma.service.js';
import type { AuthService } from './auth.service.js';
import type { SessionTokenService } from './session-token.service.js';

/**
 * OtpLoginService: admin-issued one-time login codes → the Android long-term `app` session. Covers
 * issue (plaintext reveal-once + prior-code revocation), verifyAndLogin (single-use guard, app-session
 * replacement, producedSessionId audit link, the precise expired/consumed/invalid codes), the
 * account-dimension brute-force lock, revoke, and the audit list. argon2 runs real (one hash/verify per
 * round-trip) — the failure paths that don't need it (no-code / expired / consumed) throw before verify.
 */
describe('OtpLoginService', () => {
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    user: { findUnique: vi.fn() },
    loginCode: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
  };
  const auth = { replaceAppSessions: vi.fn() };
  const sessionTokens = { issue: vi.fn(), idOfToken: vi.fn() };
  // A REAL BruteForceService drives the account-dimension throttle end-to-end (no mock) — so the lock test
  // exercises the shared engine OtpLoginService delegates to, not a stub. Built fresh per test so a ban
  // recorded in one case can't leak into another (each test gets isolated throttle state).
  let svc: OtpLoginService;

  beforeEach(() => {
    svc = new OtpLoginService(
      prisma as unknown as PrismaService,
      auth as unknown as AuthService,
      sessionTokens as unknown as SessionTokenService,
      new BruteForceService(),
    );
    prisma.user.findUnique.mockReset();
    prisma.loginCode.create.mockReset();
    prisma.loginCode.findFirst.mockReset();
    prisma.loginCode.findMany.mockReset();
    prisma.loginCode.updateMany.mockReset();
    prisma.loginCode.update.mockReset();
    auth.replaceAppSessions.mockReset();
    sessionTokens.issue.mockReset();
    sessionTokens.idOfToken.mockReset();
    // Default Promise returns — the service chains .catch() on the fire-and-forget producedSessionId
    // update, so the mocks must yield Promises (vi.fn() defaults to undefined → .catch on undefined throws).
    prisma.loginCode.update.mockResolvedValue({});
    auth.replaceAppSessions.mockResolvedValue([]);
  });

  /** Issue a code for userId 42 (admin 7) and capture the argon2 hash so a verify test can match it. */
  async function issueAndCaptureHash(): Promise<{ code: string; codeHash: string }> {
    prisma.loginCode.create.mockResolvedValue({
      id: 5,
      issuedAt: new Date(1000),
      expiresAt: new Date(2000),
      issuedBy: 7,
    });
    const r = await svc.issueCode(7, 42);
    const data = (prisma.loginCode.create.mock.calls[0][0] as { data: { codeHash: string } }).data;
    return { code: r.code, codeHash: data.codeHash };
  }

  describe('issueCode', () => {
    it('returns a 6-digit plaintext ONCE + revokes the prior unconsumed code in the same transaction', async () => {
      const r = await issueAndCaptureHash();
      expect(r.code).toMatch(/^\d{6}$/);
      expect(prisma.loginCode.updateMany).toHaveBeenCalledWith({
        where: { userId: 42, consumedAt: null, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });

  describe('verifyAndLogin', () => {
    it('verifies a correct code, replaces the app session, issues a token, records producedSessionId', async () => {
      const { code, codeHash } = await issueAndCaptureHash();
      prisma.user.findUnique.mockResolvedValue({
        id: 42,
        isGroup: false,
        isDeleted: false,
        mustChangePassword: false,
      });
      prisma.loginCode.findFirst.mockResolvedValue({
        id: 5,
        codeHash,
        consumedAt: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      prisma.loginCode.updateMany.mockResolvedValue({ count: 1 }); // single-use guard wins
      auth.replaceAppSessions.mockResolvedValue([10]);
      sessionTokens.issue.mockResolvedValue('token-xyz');
      sessionTokens.idOfToken.mockResolvedValue(99);

      const r = await svc.verifyAndLogin('alice', code, { ip: '1.2.3.4' });
      expect(r.token).toBe('token-xyz');
      expect(r.mustChangePassword).toBe(false);
      expect(auth.replaceAppSessions).toHaveBeenCalledWith(42, 'app_session_replaced');
      expect(sessionTokens.issue).toHaveBeenCalledWith(
        42,
        'app',
        expect.objectContaining({ ip: '1.2.3.4', persistent: true }),
      );
      expect(prisma.loginCode.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { producedSessionId: 99 },
      });
    });

    it('throws OTP_INVALID for a wrong code (and counts it toward the account lock)', async () => {
      const codeHash = await argon2.hash('123456');
      prisma.user.findUnique.mockResolvedValue({ id: 42, isGroup: false, isDeleted: false, mustChangePassword: false });
      prisma.loginCode.findFirst.mockResolvedValue({
        id: 5,
        codeHash,
        consumedAt: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(svc.verifyAndLogin('wcode', '000000', {})).rejects.toMatchObject({
        bizCode: BusinessCode.OTP_INVALID,
      });
    });

    it('throws OTP_EXPIRED for a past-its-expiresAt code', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 42, isGroup: false, isDeleted: false, mustChangePassword: false });
      prisma.loginCode.findFirst.mockResolvedValue({
        id: 5,
        codeHash: 'x',
        consumedAt: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(svc.verifyAndLogin('exp', '000000', {})).rejects.toMatchObject({
        bizCode: BusinessCode.OTP_EXPIRED,
      });
    });

    it('throws OTP_CONSUMED for an already-used code', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 42, isGroup: false, isDeleted: false, mustChangePassword: false });
      prisma.loginCode.findFirst.mockResolvedValue({
        id: 5,
        codeHash: 'x',
        consumedAt: new Date(),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(svc.verifyAndLogin('used', '000000', {})).rejects.toMatchObject({
        bizCode: BusinessCode.OTP_CONSUMED,
      });
    });

    it('throws OTP_INVALID for a non-existent account (NOT counted toward the lock)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(svc.verifyAndLogin('ghost', '000000', {})).rejects.toMatchObject({
        bizCode: BusinessCode.OTP_INVALID,
      });
      expect(prisma.loginCode.findFirst).not.toHaveBeenCalled();
    });

    it('locks the account (RATE_LIMITED) once failures cross the threshold — surfaced on the crossing attempt', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 42, isGroup: false, isDeleted: false, mustChangePassword: false });
      prisma.loginCode.findFirst.mockResolvedValue(null); // no active code → OTP_INVALID (counted) before argon2
      // Attempts 1–5: each OTP_INVALID (count 1..5; the tier is >5, so none bans yet).
      for (let i = 0; i < 5; i++) {
        await expect(svc.verifyAndLogin('lockme', '000000', {})).rejects.toMatchObject({
          bizCode: BusinessCode.OTP_INVALID,
        });
      }
      // 6th: crosses the threshold → failOtp surfaces RATE_LIMITED (with bannedUntil) on THIS attempt,
      // consistent with the password path (the old code waited one extra attempt).
      await expect(svc.verifyAndLogin('lockme', '000000', {})).rejects.toMatchObject({
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
      expect(prisma.loginCode.findMany).toHaveBeenCalledWith({
        where: { userId: 42 },
        orderBy: { issuedAt: 'desc' },
        select: expect.objectContaining({ producedSessionId: true }),
      });
    });
  });
});
