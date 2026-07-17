import { Injectable, HttpStatus } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { PrismaService } from '../prisma.service.js';
import { SessionTokenService } from './session-token.service.js';
import { BruteForceService, BAN_DIM_OTP, type BanStep } from './brute-force.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { normalizeAccount } from '../common/account.js';

/** How long an issued code is valid (10 min). */
const CODE_TTL_MS = 10 * 60 * 1000;

/** Account-dimension brute-force ceiling on the 6-digit code (the IP dimension is handled by the route's
 *  @Throttle). A sliding window of failures per account; past the threshold the account's OTP is locked,
 *  bounding distributed guessing — the code rotates every CODE_TTL_MS, so even a botnet can't exhaust the
 *  10^6 space against one account. Mirrors LocalStrategy's account-dimension intent (same victim-lockout
 *  tradeoff: an attacker can annoy-lock a real account for up to the ban, accepted as the cost of stopping
 *  distributed guessing). Storage + the sliding window live in the shared {@link BruteForceService}, so OTP
 *  locks are admin-visible and unbannable alongside password bans. */
const OTP_STEPS: readonly BanStep[] = [{ count: 5, banMs: 30 * 60 * 1000 }];

/** A 6-digit numeric string (000000–999999) — short enough for an admin to hand to a user and for the user
 *  to type on a phone; the 10^6 space resists guessing under the endpoint's @Throttle. */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** A login code as returned to the admin (issue + audit list). Never includes the codeHash or the session
 *  token value. `code` (plaintext) is present ONLY on issue (reveal-once). `producedSessionId` is the
 *  SessionToken row id the consumed code created — the safe, displayable audit link into session detail. */
export interface LoginCodeView {
  id: number;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedIp: string | null;
  consumedDevice: string | null;
  producedSessionId: number | null;
  revokedAt: Date | null;
  issuedBy: number;
}

/** Result of issuing a code — the plaintext is returned ONCE so the admin can hand it to the user; it is
 *  never retrievable again (only its argon2 hash is stored). */
export interface IssuedLoginCode extends LoginCodeView {
  code: string;
}

/**
 * Admin-issued one-time login codes → the Android long-term (`app`) session login method. The admin mints a
 * 6-digit code for an account; the user enters it in the Android app to obtain a no-expiry `app` session.
 *
 * Codes are argon2-hashed at rest; the plaintext is returned ONCE at issue and never stored. Single-use is
 * enforced by an `updateMany` guard at verify time (only the first concurrent verifier flips `consumedAt`).
 * Issuing a new code revokes the account's prior unconsumed code (one valid code per account at a time). On
 * verification a new trusted `app` session is issued (multiple trusted devices may coexist — each is
 * independently revocable from the device list) and the produced session id is recorded on the code for audit.
 */
@Injectable()
export class OtpLoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionTokens: SessionTokenService,
    private readonly bruteForce: BruteForceService,
  ) {}

  /** Record one OTP failure for the account, then throw. If THIS failure crosses the ban threshold, surface
   *  RATE_LIMITED + the ban deadline immediately — consistency with the password path, which surfaces the ban
   *  on the triggering attempt (the old code waited one extra attempt). Collapsing every failure code to
   *  RATE_LIMITED once banned also avoids distinguishing expired/consumed/invalid under a lock. The
   *  account-dimension throttle (the IP dimension is the route @Throttle) lives in the shared
   *  {@link BruteForceService}, so OTP locks are admin-visible/unbannable alongside password bans. Counted
   *  ONLY for real accounts (see the not-found/group/disabled guard in {@link verifyAndLogin}). */
  private failOtp(account: string, code: BusinessCode, message: string): never {
    const ban = this.bruteForce.registerFailure(BAN_DIM_OTP, account, OTP_STEPS);
    throw new BusinessException(
      ban !== undefined ? BusinessCode.RATE_LIMITED : code,
      ban !== undefined ? 'too many one-time code attempts; try again later' : message,
      HttpStatus.OK,
      ban !== undefined ? { bannedUntil: ban } : undefined,
    );
  }

  /** Mint a one-time code for a user. Revokes the user's prior unconsumed code first (one valid code per
   *  account at a time). Returns the plaintext ONCE (reveal-once) + the audit view. */
  async issueCode(adminId: number, userId: number): Promise<IssuedLoginCode> {
    const code = generateCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
    const created = await this.prisma.$transaction(async (tx) => {
      // Invalidate any prior unconsumed code so only one is redeemable at a time.
      await tx.loginCode.updateMany({
        where: { userId, consumedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      return tx.loginCode.create({
        data: {
          userId,
          codeHash: await argon2.hash(code),
          issuedBy: adminId,
          expiresAt,
        },
      });
    });
    return {
      id: created.id,
      code,
      issuedAt: created.issuedAt,
      expiresAt: created.expiresAt,
      consumedAt: null,
      consumedIp: null,
      consumedDevice: null,
      producedSessionId: null,
      revokedAt: null,
      issuedBy: created.issuedBy,
    };
  }

  /** Verify a one-time code for an account and issue a trusted (permanent) `app` session. Enforces
   *  single-use via an updateMany guard (only the first concurrent verifier wins). Prior app sessions are
   *  NOT revoked — multiple trusted devices (phones) may coexist, each independently revocable from the
   *  device list. Records the produced session id on the code for audit. Returns the plaintext session
   *  token (the caller sets it as the httpOnly cookie) + the user's `mustChangePassword` flag so the
   *  client can proactively route to the set-password screen (an OTP account whose admin-generated initial
   *  password was never rotated is gated by SessionAuthGuard regardless — this flag is the clean proactive
   *  UX, not the enforcement). Throws BusinessException(OTP_INVALID | OTP_EXPIRED | OTP_CONSUMED) on any
   *  failure. */
  async verifyAndLogin(
    account: string,
    code: string,
    opts: { device?: string; userAgent?: string; ip?: string },
  ): Promise<{ token: string; mustChangePassword: boolean }> {
    const acct = normalizeAccount(account);
    // Account-dimension brute-force lock (the IP dimension is the route @Throttle). A locked account is
    // rejected before any code lookup — RATE_LIMITED surfaces it so a legitimate user knows to wait / get a
    // new code, and an attacker already knows they're hammering. Bounds distributed guessing against one
    // account (the 6-digit space can't be exhausted once ≤5 guesses/window are allowed).
    const ban = this.bruteForce.activeBanUntil([{ dimension: BAN_DIM_OTP, value: acct }]);
    if (ban !== undefined) {
      throw new BusinessException(
        BusinessCode.RATE_LIMITED,
        'too many one-time code attempts; try again later',
        HttpStatus.OK,
        { bannedUntil: ban },
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { account_domain: { account: acct, domain: 'local' } },
      select: { id: true, isGroup: true, isDeleted: true, mustChangePassword: true },
    });
    // Non-revealing: a non-existent / group / disabled account is indistinguishable from a wrong code. NOT
    // counted toward the lock — there is no real account to protect, and counting arbitrary input strings
    // would let an attacker fill the failure map.
    if (!user || user.isGroup || user.isDeleted) {
      throw new BusinessException(BusinessCode.OTP_INVALID, 'invalid one-time code');
    }

    // Inspect the most-recent code to return a precise failure code (expired / consumed / invalid). Each is
    // a guessable failure → counted toward the account lock.
    const latest = await this.prisma.loginCode.findFirst({
      where: { userId: user.id },
      orderBy: { issuedAt: 'desc' },
    });
    if (!latest || latest.revokedAt) {
      this.failOtp(acct, BusinessCode.OTP_INVALID, 'invalid one-time code');
    }
    if (latest.consumedAt) {
      this.failOtp(acct, BusinessCode.OTP_CONSUMED, 'one-time code already used');
    }
    if (latest.expiresAt.getTime() <= Date.now()) {
      this.failOtp(acct, BusinessCode.OTP_EXPIRED, 'one-time code expired');
    }
    const match = await argon2.verify(latest.codeHash, code);
    if (!match) {
      this.failOtp(acct, BusinessCode.OTP_INVALID, 'invalid one-time code');
    }

    // Single-use guard: only the first concurrent verifier flips consumedAt from null. A 0 count means the
    // race was lost → treat as consumed (the other verifier got the session).
    const now = new Date();
    const consumed = await this.prisma.loginCode.updateMany({
      where: { id: latest.id, consumedAt: null, revokedAt: null },
      data: { consumedAt: now, consumedIp: opts.ip ?? null, consumedDevice: opts.device ?? null },
    });
    if (consumed.count === 0) {
      throw new BusinessException(BusinessCode.OTP_CONSUMED, 'one-time code already used');
    }

    const token = await this.sessionTokens.issue(user.id, 'app', {
      device: opts.device,
      userAgent: opts.userAgent,
      ip: opts.ip,
      persistent: true,
    });
    // Record the produced session id on the code for audit (best-effort link; never the token value).
    const sessionId = await this.sessionTokens.idOfToken(token);
    if (sessionId !== null) {
      await this.prisma.loginCode
        .update({ where: { id: latest.id }, data: { producedSessionId: sessionId } })
        .catch(() => {});
    }
    this.bruteForce.clearFailures(BAN_DIM_OTP, acct); // success clears the account's OTP failure history
    return { token, mustChangePassword: user.mustChangePassword };
  }

  /** Audit list of a user's login codes — never the codeHash or token value; producedSessionId links into
   *  the session-management detail view. Newest first. */
  async listCodes(userId: number): Promise<LoginCodeView[]> {
    return this.prisma.loginCode.findMany({
      where: { userId },
      orderBy: { issuedAt: 'desc' },
      select: {
        id: true,
        issuedAt: true,
        expiresAt: true,
        consumedAt: true,
        consumedIp: true,
        consumedDevice: true,
        producedSessionId: true,
        revokedAt: true,
        issuedBy: true,
      },
    });
  }

  /** Revoke an unused code (admin cancellation). Only an unconsumed, unrevoked code can be revoked.
   *  Returns true iff a row was actually revoked. */
  async revokeCode(codeId: number): Promise<boolean> {
    const r = await this.prisma.loginCode.updateMany({
      where: { id: codeId, consumedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return r.count > 0;
  }
}
