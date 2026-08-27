import { Injectable, HttpStatus } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  account as accountTable,
  loginCode,
  user as userTable,
} from '../database/schema.js';
import { SessionTokenService } from './session-token.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  BruteForceService,
  BAN_DIM_OTP,
  type BanStep,
} from './brute-force.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { normalizeAccount } from '../common/account.js';

/** Account-dimension brute-force ceiling on the 6-digit code (the IP dimension is handled by the OTP
 *  rate-limit policy). A sliding window of failures per account; past the threshold the account's OTP is locked,
 *  bounding distributed guessing — codes are short-lived (admin-configured, default ~10 min) and rotate each
 *  issue, so even a botnet can't exhaust the 10^6 space against one account. Mirrors LocalStrategy's
 *  account-dimension intent (same victim-lockout tradeoff: an attacker can annoy-lock a real account for up
 *  to the ban, accepted as the cost of stopping distributed guessing). Storage + the sliding window live in
 *  the shared {@link BruteForceService}, so OTP locks are admin-visible and unbannable alongside password
 *  bans. */
const OTP_STEPS: readonly BanStep[] = [{ count: 5, banMs: 30 * 60 * 1000 }];

/** Upper bound on how many active codes verifyAndLogin will scan (newest-first). Bounds the argon2 work per
 *  attempt: codes are admin-issued + short-lived so the live set is normally tiny, but multi-issue can leave
 *  stale unconsumed codes behind — this caps the worst case at a constant instead of O(all active codes). */
const VERIFY_CANDIDATE_LIMIT = 8;

/** A 6-digit numeric string (000000–999999) — short enough for an admin to hand to a user and for the user
 *  to type on a phone; the 10^6 space resists guessing under the endpoint's rate-limit policy. */
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
 * Admin-issued one-time login codes → an OTP login method available on every platform. The admin mints a
 * 6-digit code for an account; the user enters it to obtain a session under the same inactivity policy as
 * every other login method.
 *
 * Codes are argon2-hashed at rest; the plaintext is returned ONCE at issue and never stored. Single-use is
 * enforced by an `updateMany` guard at verify time (only the first concurrent verifier flips `consumedAt`).
 * Multiple codes may be active per account at once — issuing does NOT revoke prior unconsumed codes (an
 * admin can mint a fresh one for a user who lost the first), and verification accepts ANY active (unconsumed,
 * unrevoked) code whose hash matches. The validity window is admin-configurable (SettingsService, default
 * 10 min). On verification the produced session id is recorded on the consumed code for audit; prior sessions
 * are NOT revoked (multiple devices may coexist — each independently revocable from the device list).
 */
@Injectable()
export class OtpLoginService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessionTokens: SessionTokenService,
    private readonly bruteForce: BruteForceService,
    private readonly settings: SettingsService,
  ) {}

  /** Record one OTP failure for the account, then throw. If THIS failure crosses the ban threshold, surface
   *  RATE_LIMITED + the ban deadline immediately — consistency with the password path, which surfaces the ban
   *  on the triggering attempt (the old code waited one extra attempt). Collapsing every failure code to
   *  RATE_LIMITED once banned also avoids distinguishing expired/consumed/invalid under a lock. The
   *  account-dimension throttle (the IP dimension is the OTP rate-limit policy) lives in the shared
   *  {@link BruteForceService}, so OTP locks are admin-visible/unbannable alongside password bans. Counted
   *  ONLY for real accounts (see the not-found/group/disabled guard in {@link verifyAndLogin}). */
  private failOtp(account: string, code: BusinessCode, message: string): never {
    const ban = this.bruteForce.registerFailure(
      BAN_DIM_OTP,
      account,
      OTP_STEPS,
    );
    throw new BusinessException(
      ban !== undefined ? BusinessCode.RATE_LIMITED : code,
      ban !== undefined
        ? 'too many one-time code attempts; try again later'
        : message,
      HttpStatus.OK,
      ban !== undefined ? { bannedUntil: ban } : undefined,
    );
  }

  /** Mint a one-time code for a user. Does NOT revoke prior unconsumed codes — multiple may be active at
   *  once (an admin can re-mint for a user who lost the first); verification matches any active one. The
   *  validity window is the admin-configured OTP TTL (SettingsService, default 10 min). Returns the plaintext
   *  ONCE (reveal-once) + the audit view. */
  async issueCode(adminId: number, userId: number): Promise<IssuedLoginCode> {
    const [target] = await this.database.db
      .select({ id: accountTable.id })
      .from(accountTable)
      .innerJoin(userTable, eq(userTable.id, accountTable.id))
      .where(and(eq(accountTable.id, userId), eq(userTable.domain, 'local')))
      .limit(1);
    if (!target) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'local user not found',
      );
    }
    const code = generateCode();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + (await this.settings.getOtpTtlMinutes()) * 60_000,
    );
    const created = await this.database.db
      .insert(loginCode)
      .values({
        userId,
        codeHash: await argon2.hash(code),
        issuedBy: adminId,
        // Keep both ends of the validity window on the same clock. Relying on the
        // database CURRENT_TIMESTAMP here while computing expiresAt in Node can
        // skew the displayed duration when their timezone settings differ.
        issuedAt: now,
        expiresAt,
      })
      .returning()
      .then(([row]) => row);
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

  /** Verify a one-time code for an account and issue a session. Accepts ANY active (unconsumed + unrevoked)
   *  code whose argon2 hash matches the entered value — multiple codes may be active per account (multi-
   *  issue). Enforces single-use via an updateMany guard on the matched code (only the first concurrent
   *  verifier wins). Prior sessions are NOT revoked — multiple devices may coexist, each independently
   *  revocable from the device list. Records the produced session id on the consumed code for audit. Returns
   *  the plaintext session token + the user's `mustChangePassword` flag (proactive set-password routing).
   *  Throws BusinessException(OTP_INVALID | OTP_EXPIRED | OTP_CONSUMED) on any failure. */
  async verifyAndLogin(
    account: string,
    code: string,
    opts: {
      device?: string;
      userAgent?: string;
      ip?: string;
      client?: 'app' | 'web' | 'desktop';
    },
  ): Promise<{ token: string; mustChangePassword: boolean }> {
    const acct = normalizeAccount(account);
    // Account-dimension brute-force lock (the IP dimension is the OTP rate-limit policy). A locked account is
    // rejected before any code lookup — RATE_LIMITED surfaces it so a legitimate user knows to wait / get a
    // new code, and an attacker already knows they're hammering. Bounds distributed guessing against one
    // account (the 6-digit space can't be exhausted once ≤5 guesses/window are allowed).
    const ban = this.bruteForce.activeBanUntil([
      { dimension: BAN_DIM_OTP, value: acct },
    ]);
    if (ban !== undefined) {
      throw new BusinessException(
        BusinessCode.RATE_LIMITED,
        'too many one-time code attempts; try again later',
        HttpStatus.OK,
        { bannedUntil: ban },
      );
    }
    const [user] = await this.database.db
      .select({
        id: userTable.id,
        availability: userTable.availability,
        disabledAt: accountTable.disabledAt,
        mustChangePassword: accountTable.mustChangePassword,
      })
      .from(userTable)
      .innerJoin(accountTable, eq(accountTable.id, userTable.id))
      .where(and(eq(userTable.account, acct), eq(userTable.domain, 'local')))
      .limit(1);
    // Non-revealing: a non-existent / group / disabled account is indistinguishable from a wrong code. NOT
    // counted toward the lock — there is no real account to protect, and counting arbitrary input strings
    // would let an attacker fill the failure map.
    if (
      !user ||
      user.availability === 'REMOVED' ||
      user.disabledAt !== null
    ) {
      throw new BusinessException(
        BusinessCode.OTP_INVALID,
        'invalid one-time code',
      );
    }

    // Multi-issue: several codes may be active per account. Fetch the newest unconsumed + unrevoked
    // candidates (capped — see VERIFY_CANDIDATE_LIMIT; expired ones kept so an expired code's value reports
    // OTP_EXPIRED, not OTP_INVALID) and find the one whose argon2 hash matches the entered value. A code
    // value matches at most one hash. Each failure below is a guessable failure → counted toward the account
    // lock (failOtp throws).
    const candidates = await this.database.db
      .select()
      .from(loginCode)
      .where(
        and(
          eq(loginCode.userId, user.id),
          isNull(loginCode.consumedAt),
          isNull(loginCode.revokedAt),
        ),
      )
      .orderBy(desc(loginCode.issuedAt))
      .limit(VERIFY_CANDIDATE_LIMIT);
    let matched: { id: number } | null = null;
    let expiredMatch = false;
    for (const c of candidates) {
      if (await argon2.verify(c.codeHash, code)) {
        if (c.expiresAt.getTime() <= Date.now()) expiredMatch = true;
        else matched = { id: c.id };
        break;
      }
    }
    if (!matched) {
      // Expired-code value → precise OTP_EXPIRED; otherwise (wrong value, or reuse of a consumed code's
      // value — consumed codes aren't in the candidate set) → OTP_INVALID. Both are counted failures.
      this.failOtp(
        acct,
        expiredMatch ? BusinessCode.OTP_EXPIRED : BusinessCode.OTP_INVALID,
        expiredMatch ? 'one-time code expired' : 'invalid one-time code',
      );
    }

    // Single-use guard: only the first concurrent verifier flips consumedAt from null on the matched code.
    // A 0 count means the race was lost → treat as consumed (the other verifier got the session).
    const now = new Date();
    const consumed = await this.database.db
      .update(loginCode)
      .set({
        consumedAt: now,
        consumedIp: opts.ip ?? null,
        consumedDevice: opts.device ?? null,
      })
      .where(
        and(
          eq(loginCode.id, matched.id),
          isNull(loginCode.consumedAt),
          isNull(loginCode.revokedAt),
        ),
      )
      .returning({ id: loginCode.id });
    if (consumed.length === 0) {
      throw new BusinessException(
        BusinessCode.OTP_CONSUMED,
        'one-time code already used',
      );
    }

    const client = opts.client ?? 'app';
    const token = await this.sessionTokens.issue(user.id, client, {
      device: opts.device,
      userAgent: opts.userAgent,
      ip: opts.ip,
    });
    // Record the produced session id on the code for audit (best-effort link; never the token value).
    const sessionId = await this.sessionTokens.idOfToken(token);
    if (sessionId !== null) {
      await this.database.db
        .update(loginCode)
        .set({ producedSessionId: sessionId })
        .where(eq(loginCode.id, matched.id))
        .catch(() => {});
    }
    this.bruteForce.clearFailures(BAN_DIM_OTP, acct); // success clears the account's OTP failure history
    return { token, mustChangePassword: user.mustChangePassword };
  }

  /** Audit list of a user's login codes — never the codeHash or token value; producedSessionId links into
   *  the session-management detail view. Newest first. */
  async listCodes(userId: number): Promise<LoginCodeView[]> {
    return this.database.db.query.loginCode.findMany({
      where: eq(loginCode.userId, userId),
      orderBy: desc(loginCode.issuedAt),
      columns: {
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
    const rows = await this.database.db
      .update(loginCode)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(loginCode.id, codeId),
          isNull(loginCode.consumedAt),
          isNull(loginCode.revokedAt),
        ),
      )
      .returning({ id: loginCode.id });
    return rows.length > 0;
  }
}
