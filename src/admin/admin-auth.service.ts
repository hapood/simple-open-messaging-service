import { Injectable, HttpStatus } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { and, count, desc, eq, gt, isNull, like } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { admin, adminSession, user } from '../database/schema.js';
import { jwtConstants } from '../auth/constants.js';
import { normalizeAccount } from '../common/account.js';
import { AdminRole } from '../database/enums.js';
import {
  BruteForceService,
  BAN_DIM_ADMIN_PWD,
  BAN_DIM_ADMIN_2FA,
  type BanStep,
} from '../auth/brute-force.service.js';
import { PasswordHasher } from '../auth/password-hasher.service.js';
import { TwoFactorService, type SetupBundle } from './two-factor.service.js';
import {
  WebAuthnService,
  type WebAuthnCredentialView,
} from './webauthn.service.js';
import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { WEBAUTHN_CONFIG } from './webauthn.config.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  ADMIN_SESSION_IDLE_MS,
  ADMIN_SESSION_TTL_MS,
} from './admin-session.js';

/**
 * Admin auth service: mirrors AuthService's family-based + reuse-detection algorithm. Identity (account + password)
 * lives on the linked User; this service operates on the separate Admin/AdminRefreshToken tables and signs tokens with
 * a separate adminSecret carrying scope:'admin' (physically isolated from user auth — the two never interoperate).
 */
type AdminSessionOpts = { ip?: string; userAgent?: string };

/** Account-dimension progressive-ban steps for admin password login (the IP ceiling is the route @Throttle).
 *  Same shape as the user-side password path: escalating lockouts, sliding 15-min window in BruteForceService. */
const ADMIN_PWD_STEPS: readonly BanStep[] = [
  { count: 5, banMs: 30 * 60 * 1000 },
  { count: 10, banMs: 3 * 60 * 60 * 1000 },
  { count: 20, banMs: 24 * 60 * 60 * 1000 },
];
/** Account-dimension brute-force ceiling on the 6-digit TOTP / 8-char backup code (mirrors OtpLoginService:
 *  the 10^6 code space can't be exhausted once ≤5 guesses/window are allowed). */
const ADMIN_2FA_STEPS: readonly BanStep[] = [
  { count: 5, banMs: 30 * 60 * 1000 },
];

/** Login outcome: an authenticated session — the opaque session token is delivered via the httpOnly
 *  admin_session cookie (set by the controller, never the response body) — or a second-factor challenge
 *  (password verified → no session yet). `factors` tells the client which affordances to show at the
 *  challenge step (TOTP/backup vs passkey); it leaks nothing — the password already proved identity by
 *  the time this is emitted. */
export type AdminLoginResult =
  | { sessionToken: string }
  | {
      twoFactorRequired: true;
      challengeToken: string;
      factors: { totp: boolean; webauthn: boolean };
    };

@Injectable()
export class AdminAuthService {
  constructor(
    private database: DatabaseService,
    private jwtService: JwtService,
    private bruteForce: BruteForceService,
    private twoFactor: TwoFactorService,
    private passwordHasher: PasswordHasher,
    private webAuthn: WebAuthnService,
  ) {}

  /** Admin login: identity is on the linked User (single account namespace) → verify User.hashPwd → require an
   *  enabled Admin profile. When 2FA is enrolled, the password verifying issues a short-lived CHALLENGE token (no
   *  session yet); /admin/login/verify completes login after the TOTP/backup code. Account-dimension progressive
   *  banning lives in BruteForceService (the IP ceiling is the route @Throttle); a wrong password throws
   *  INVALID_CREDENTIALS (or RATE_LIMITED once the threshold trips). */
  async login(
    account: string,
    password: string,
    ip?: string,
    userAgent?: string,
  ): Promise<AdminLoginResult> {
    const acct = normalizeAccount(account);
    // Pre-check the account-dimension lock before the (slow) argon2 verify. The IP ceiling is @Throttle(5,60).
    const ban = this.bruteForce.activeBanUntil([
      { dimension: BAN_DIM_ADMIN_PWD, value: acct },
    ]);
    if (ban !== undefined) {
      throw new BusinessException(
        BusinessCode.RATE_LIMITED,
        'too many login attempts; try again later',
        HttpStatus.OK,
        { bannedUntil: ban },
      );
    }
    const userRow = await this.database.db.query.user.findFirst({
      where: and(eq(user.account, acct), eq(user.domain, 'local')),
    });
    // Non-revealing: a missing / deleted / group identity, no admin profile, a disabled admin, a no-password
    // account, or a wrong password are all indistinguishable from the caller's view (INVALID_CREDENTIALS).
    // NOT counted when there is no real enabled admin to protect (avoids filling the failure map with noise).
    const adminProfile =
      userRow && !userRow.isDeleted && !userRow.isGroup
        ? await this.database.db.query.admin.findFirst({
            where: eq(admin.userId, userRow.id),
          })
        : null;
    const passwordOk =
      !!adminProfile &&
      adminProfile.enabled &&
      !!userRow &&
      !!userRow.hashPwd &&
      (await this.passwordHasher.verify(userRow.hashPwd, password));
    if (!passwordOk || !adminProfile) {
      if (adminProfile) {
        // Real enabled admin + wrong password → count toward the progressive lock.
        this.failAdminPwd(acct);
      }
      throw new BusinessException(
        BusinessCode.INVALID_CREDENTIALS,
        'invalid credentials',
        HttpStatus.OK,
      );
    }

    // Password verified. Branch: a second factor is required (TOTP and/or a passkey) → challenge; otherwise
    // issue the session right away. The SAME challenge token (scope admin-2fa-challenge) is consumed by
    // either POST admin/login/verify (TOTP/backup) or POST admin/webauthn/login/finish (passkey assertion).
    const hasTotp = adminProfile.twoFactorEnabled;
    const hasWebauthn = adminProfile.webauthnEnabled;
    if (hasTotp || hasWebauthn) {
      return {
        twoFactorRequired: true,
        challengeToken: await this.twoFactor.signChallenge(adminProfile.id),
        factors: { totp: hasTotp, webauthn: hasWebauthn },
      };
    }
    await this.completeLogin(adminProfile.id, ip);
    return {
      sessionToken: await this.createAdminSession(adminProfile.id, {
        ip,
        userAgent,
      }),
    };
  }

  /** Complete a 2FA login: verify the challenge token, check the account lock, validate the TOTP (with the
   *  same-window replay guard) OR consume a backup code, then issue the session. Throws on any failure. */
  async verifyLogin(
    challengeToken: string,
    code: string | undefined,
    backupCode: string | undefined,
    ip?: string,
    userAgent?: string,
  ): Promise<{ sessionToken: string }> {
    const decoded = this.twoFactor.verifyChallenge(challengeToken);
    if (decoded === null) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_CHALLENGE_EXPIRED,
        'login session expired; please sign in again',
        HttpStatus.OK,
      );
    }
    const { adminId, jti } = decoded;
    const adminRow = await this.database.db.query.admin.findFirst({
      where: eq(admin.id, adminId),
      columns: {
        id: true,
        enabled: true,
        twoFactorEnabled: true,
        twoFactorSecretCipher: true,
        twoFactorLastUsedCounter: true,
      },
      with: { user: { columns: { account: true } } },
    });
    // 2FA disabled / admin gone mid-challenge → the admin must restart login (no session to leak).
    if (
      !adminRow ||
      !adminRow.enabled ||
      !adminRow.twoFactorEnabled ||
      !adminRow.twoFactorSecretCipher
    ) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_NOT_ENABLED,
        'two-factor is not enabled for this account',
        HttpStatus.OK,
      );
    }
    const acct = adminRow.user.account;
    const ban = this.bruteForce.activeBanUntil([
      { dimension: BAN_DIM_ADMIN_2FA, value: acct },
    ]);
    if (ban !== undefined) {
      throw new BusinessException(
        BusinessCode.RATE_LIMITED,
        'too many code attempts; try again later',
        HttpStatus.OK,
        { bannedUntil: ban },
      );
    }

    const passed = await this.verifyFactor(
      adminRow,
      code,
      backupCode,
      /*advanceCounter*/ true,
    );
    if (!passed) this.failAdmin2FA(acct);

    // Single-use challenge: a captured/replayed challenge cannot buy a second session.
    if (!(await this.twoFactor.consumeChallenge(jti))) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_CHALLENGE_EXPIRED,
        'login session expired; please sign in again',
        HttpStatus.OK,
      );
    }
    this.bruteForce.clearFailures(BAN_DIM_ADMIN_2FA, acct);
    await this.completeLogin(adminRow.id, ip);
    return {
      sessionToken: await this.createAdminSession(adminRow.id, {
        ip,
        userAgent,
      }),
    };
  }

  // ── Two-factor enrollment + management (self-service; the caller is the authenticated admin) ──────

  /** Begin 2FA enrollment: mint a secret + provisioning URI + a signed pending token (stateless — no DB write
   *  until the admin confirms with their first code). Refuses if already enrolled. */
  async beginTwoFactorSetup(adminId: number): Promise<SetupBundle> {
    const adminRow = await this.database.db.query.admin.findFirst({
      where: eq(admin.id, adminId),
      columns: { twoFactorEnabled: true },
      with: { user: { columns: { account: true, name: true } } },
    });
    if (!adminRow)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'admin not found',
        HttpStatus.OK,
      );
    if (adminRow.twoFactorEnabled) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_ALREADY_ENABLED,
        'two-factor is already enabled; disable it first to re-enroll',
        HttpStatus.OK,
      );
    }
    return this.twoFactor.beginSetup(
      adminId,
      adminRow.user.account,
      adminRow.user.name,
    );
  }

  /** Confirm enrollment: verify the pending token + the first code, persist the encrypted secret + backup codes,
   *  then invalidate every existing session so the admin re-logs in through the new 2FA challenge. Returns the
   *  backup codes plaintext ONCE. */
  async completeTwoFactorSetup(
    adminId: number,
    pendingToken: string,
    code: string,
  ): Promise<{ backupCodes: string[] }> {
    const pending = this.twoFactor.verifyPending(pendingToken);
    if (!pending || pending.adminId !== adminId) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_CHALLENGE_EXPIRED,
        'setup session expired; please start again',
        HttpStatus.OK,
      );
    }
    // No replay guard pre-enable (counter is null); window=1 tolerance covers phone/server clock drift.
    if (!this.twoFactor.verifyTotp(pending.secret, code, null).ok) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_INVALID,
        'invalid verification code',
        HttpStatus.OK,
      );
    }
    const { backupCodes } = await this.twoFactor.enableWithBackupCodes(
      adminId,
      pending.secret,
    );
    // Revoking outstanding sessions forces an immediate re-login through the new 2FA challenge (rather
    // than waiting for session expiry) — no pre-enrollment session can bypass the new factor. The admin
    // just proved enrollment, so the forced re-login is expected.
    await this.revokeSessionsByAdmin(adminId, '2fa_enabled');
    return { backupCodes };
  }

  /** Disable 2FA. Requires the current password AND a live 2FA factor (TOTP or backup code) so a hijacked
   *  session alone cannot turn the second factor off. Burns the consumed backup code (if used). */
  async disableTwoFactor(
    adminId: number,
    password: string,
    code: string | undefined,
    backupCode: string | undefined,
  ): Promise<void> {
    const adminRow = await this.database.db.query.admin.findFirst({
      where: eq(admin.id, adminId),
      columns: {
        id: true,
        twoFactorEnabled: true,
        twoFactorSecretCipher: true,
        twoFactorLastUsedCounter: true,
      },
      with: { user: { columns: { account: true, hashPwd: true } } },
    });
    if (!adminRow)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'admin not found',
        HttpStatus.OK,
      );
    if (!adminRow.twoFactorEnabled) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_NOT_ENABLED,
        'two-factor is not enabled',
        HttpStatus.OK,
      );
    }
    const acct = adminRow.user.account;
    if (
      !adminRow.user.hashPwd ||
      !(await this.passwordHasher.verify(adminRow.user.hashPwd, password))
    ) {
      throw new BusinessException(
        BusinessCode.INVALID_CREDENTIALS,
        'invalid credentials',
        HttpStatus.OK,
      );
    }
    // A wrong 2FA factor counts toward the lock (same surface as login verify).
    if (
      !(await this.verifyFactor(
        adminRow,
        code,
        backupCode,
        /*advanceCounter*/ false,
      ))
    ) {
      this.failAdmin2FA(acct);
    }
    await this.twoFactor.disable(adminId);
    await this.revokeSessionsByAdmin(adminId, '2fa_disabled');
  }

  /** Regenerate the backup-code set (requires a live TOTP or backup code). Returns the new codes plaintext ONCE. */
  async regenerateBackupCodes(
    adminId: number,
    code: string | undefined,
    backupCode: string | undefined,
  ): Promise<{ backupCodes: string[] }> {
    const adminRow = await this.database.db.query.admin.findFirst({
      where: eq(admin.id, adminId),
      columns: {
        id: true,
        twoFactorEnabled: true,
        twoFactorSecretCipher: true,
        twoFactorLastUsedCounter: true,
      },
      with: { user: { columns: { account: true } } },
    });
    if (
      !adminRow ||
      !adminRow.twoFactorEnabled ||
      !adminRow.twoFactorSecretCipher
    ) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_NOT_ENABLED,
        'two-factor is not enabled',
        HttpStatus.OK,
      );
    }
    const acct = adminRow.user.account;
    if (
      !(await this.verifyFactor(
        adminRow,
        code,
        backupCode,
        /*advanceCounter*/ false,
      ))
    ) {
      this.failAdmin2FA(acct);
    }
    return this.twoFactor.regenerateBackupCodes(adminId);
  }

  /** 2FA status for the security card. */
  async twoFactorStatus(adminId: number): Promise<{
    enabled: boolean;
    enabledAt: Date | null;
    backupCodesRemaining: number;
  }> {
    const adminRow = await this.database.db.query.admin.findFirst({
      where: eq(admin.id, adminId),
      columns: { twoFactorEnabled: true, twoFactorEnabledAt: true },
    });
    if (!adminRow)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'admin not found',
        HttpStatus.OK,
      );
    return {
      enabled: adminRow.twoFactorEnabled,
      enabledAt: adminRow.twoFactorEnabledAt,
      backupCodesRemaining: adminRow.twoFactorEnabled
        ? await this.twoFactor.remainingBackupCodes(adminId)
        : 0,
    };
  }

  /** SUPER_ADMIN lockout-recovery: clear another admin's 2FA outright (no code required — gated by the
   *  SUPER_ADMIN role at the controller, and audited). Idempotent. Revokes the target's outstanding
   *  sessions so they re-login after the reset (a locked-out admin may still hold sessions from before
   *  the lockout). */
  async resetTwoFactorBySuper(targetAdminId: number): Promise<void> {
    const adminRow = await this.database.db.query.admin.findFirst({
      where: eq(admin.id, targetAdminId),
      columns: { twoFactorEnabled: true },
    });
    if (!adminRow)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'admin not found',
        HttpStatus.OK,
      );
    if (!adminRow.twoFactorEnabled) return; // nothing to reset
    await this.twoFactor.disable(targetAdminId);
    await this.revokeSessionsByAdmin(targetAdminId, '2fa_reset');
  }

  // ── WebAuthn (passkey) login — consumed at the challenge step alongside TOTP ──────────────────

  /** Begin a passkey login: decode the challenge token (proves the password verified), confirm the admin
   *  still has a passkey enabled, pre-check the 2FA lock, then mint assertion options. The challenge token
   *  is the SAME admin-2fa-challenge token issued by login(); the inner webauthn-assert-pending token is
   *  minted here and carries the per-attempt challenge. */
  async beginWebAuthnLogin(
    challengeToken: string,
  ): Promise<{ options: unknown; pendingToken: string }> {
    const decoded = this.twoFactor.verifyChallenge(challengeToken);
    if (decoded === null) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_CHALLENGE_EXPIRED,
        'login session expired; please sign in again',
        HttpStatus.OK,
      );
    }
    const { adminId } = decoded;
    const adminRow = await this.database.db.query.admin.findFirst({
      where: eq(admin.id, adminId),
      columns: { enabled: true, webauthnEnabled: true },
      with: { user: { columns: { account: true } } },
    });
    if (!adminRow || !adminRow.enabled || !adminRow.webauthnEnabled) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_NOT_ENABLED,
        'no passkey is enabled for this account',
        HttpStatus.OK,
      );
    }
    const ban = this.bruteForce.activeBanUntil([
      { dimension: BAN_DIM_ADMIN_2FA, value: adminRow.user.account },
    ]);
    if (ban !== undefined) {
      throw new BusinessException(
        BusinessCode.RATE_LIMITED,
        'too many code attempts; try again later',
        HttpStatus.OK,
        { bannedUntil: ban },
      );
    }
    return this.webAuthn.beginAssertion(adminId);
  }

  /** Finish a passkey login: re-decode the challenge token, verify the assertion, and on success issue the
   *  admin session via the SAME helpers password/TOTP login use. A failed assertion counts toward the 2FA
   *  lock (defense-in-depth — assertions are cryptographically unforgeable, so failures are rare). */
  async verifyWebAuthnLogin(
    challengeToken: string,
    pendingToken: string,
    assertion: AuthenticationResponseJSON,
    ip?: string,
    userAgent?: string,
  ): Promise<{ sessionToken: string }> {
    const decoded = this.twoFactor.verifyChallenge(challengeToken);
    if (decoded === null) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_CHALLENGE_EXPIRED,
        'login session expired; please sign in again',
        HttpStatus.OK,
      );
    }
    const { adminId, jti } = decoded;
    const adminRow = await this.database.db.query.admin.findFirst({
      where: eq(admin.id, adminId),
      columns: { enabled: true },
      with: { user: { columns: { account: true } } },
    });
    if (!adminRow || !adminRow.enabled) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_NOT_ENABLED,
        'account is not available',
        HttpStatus.OK,
      );
    }
    const acct = adminRow.user.account;
    const ban = this.bruteForce.activeBanUntil([
      { dimension: BAN_DIM_ADMIN_2FA, value: acct },
    ]);
    if (ban !== undefined) {
      throw new BusinessException(
        BusinessCode.RATE_LIMITED,
        'too many code attempts; try again later',
        HttpStatus.OK,
        { bannedUntil: ban },
      );
    }
    const result = await this.webAuthn.verifyAssertion(
      adminId,
      pendingToken,
      assertion,
    );
    if (!result.ok) this.failAdmin2FA(acct);

    // Single-use challenge: a replayed (captured) assertion cannot buy a second session — critical for
    // counter=0 platform passkeys, whose signature never changes so the counter CAS alone can't detect replay.
    if (!(await this.twoFactor.consumeChallenge(jti))) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_CHALLENGE_EXPIRED,
        'login session expired; please sign in again',
        HttpStatus.OK,
      );
    }
    this.bruteForce.clearFailures(BAN_DIM_ADMIN_2FA, acct);
    await this.completeLogin(adminId, ip);
    return {
      sessionToken: await this.createAdminSession(adminId, { ip, userAgent }),
    };
  }

  // ── WebAuthn enrollment + management (self-service; caller is the authenticated admin) ──────────

  /** Begin passkey enrollment. Requires the CURRENT password (re-auth) so a hijacked-but-still-valid
   *  access token cannot enroll an attacker-controlled passkey — the Google/GitHub pattern. Passkeys are
   *  an additive optional factor, so enroll/remove do NOT revoke existing sessions (unlike TOTP-enable). */
  async beginWebAuthnRegistration(
    adminId: number,
    password: string,
    nickname?: string,
  ): Promise<{ options: unknown; pendingToken: string }> {
    const adminRow = await this.database.db.query.admin.findFirst({
      where: eq(admin.id, adminId),
      columns: { id: true },
      with: {
        user: { columns: { account: true, name: true, hashPwd: true } },
      },
    });
    if (!adminRow)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'admin not found',
        HttpStatus.OK,
      );
    if (
      !adminRow.user.hashPwd ||
      !(await this.passwordHasher.verify(adminRow.user.hashPwd, password))
    ) {
      throw new BusinessException(
        BusinessCode.INVALID_CREDENTIALS,
        'invalid credentials',
        HttpStatus.OK,
      );
    }
    return this.webAuthn.beginRegistration(
      adminId,
      adminRow.user.account,
      adminRow.user.name,
      nickname,
    );
  }

  /** Confirm enrollment: verify the registration response + persist the credential. A passkey is an
   *  additive optional factor, so this does NOT revoke existing sessions — enrollment already required
   *  password re-auth at the begin step, so a session-hijacker cannot enroll their own passkey. */
  async completeWebAuthnRegistration(
    adminId: number,
    pendingToken: string,
    registration: RegistrationResponseJSON,
  ): Promise<{
    id: string;
    nickname: string | null;
    deviceType: string | null;
    backed: boolean;
  }> {
    return this.webAuthn.completeRegistration(
      adminId,
      pendingToken,
      registration,
    );
  }

  async listWebAuthnCredentials(
    adminId: number,
  ): Promise<WebAuthnCredentialView[]> {
    return this.webAuthn.listCredentials(adminId);
  }

  async renameWebAuthnCredential(
    adminId: number,
    rowId: number,
    nickname: string,
  ): Promise<void> {
    await this.webAuthn.renameCredential(adminId, rowId, nickname);
  }

  /** Remove a passkey credential. Additive factor — does NOT revoke existing sessions (mirrors
   *  enrollment; see completeWebAuthnRegistration). */
  async removeWebAuthnCredential(
    adminId: number,
    rowId: number,
  ): Promise<{ remaining: number }> {
    return this.webAuthn.removeCredential(adminId, rowId);
  }

  /** Passkey status for the security card. */
  async webAuthnStatus(adminId: number): Promise<{
    available: boolean;
    enabled: boolean;
    credentialCount: number;
  }> {
    const adminRow = await this.database.db.query.admin.findFirst({
      where: eq(admin.id, adminId),
      columns: { webauthnEnabled: true },
    });
    if (!adminRow)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'admin not found',
        HttpStatus.OK,
      );
    return {
      available: WEBAUTHN_CONFIG.available,
      enabled: adminRow.webauthnEnabled,
      credentialCount: await this.webAuthn.countCredentials(adminId),
    };
  }

  // ── 2FA helpers ───────────────────────────────────────────────────────────────

  /** Validate a 2FA factor against an admin: a TOTP code (optionally advancing the replay counter) OR a backup
   *  code (consumed on success). Returns false (no throw) on mismatch so the caller can apply brute-force. */
  private async verifyFactor(
    adminRecord: {
      id: number;
      twoFactorSecretCipher: string | null;
      twoFactorLastUsedCounter: number | null;
    },
    code: string | undefined,
    backupCode: string | undefined,
    advanceCounter: boolean,
  ): Promise<boolean> {
    if (backupCode)
      return this.twoFactor.consumeBackupCode(adminRecord.id, backupCode);
    if (code && adminRecord.twoFactorSecretCipher) {
      const secret = this.twoFactor.decryptSecret(
        adminRecord.twoFactorSecretCipher,
      );
      const check = this.twoFactor.verifyTotp(
        secret,
        code,
        adminRecord.twoFactorLastUsedCounter,
      );
      if (check.ok) {
        if (advanceCounter) {
          await this.database.db
            .update(admin)
            .set({
              twoFactorLastUsedCounter: check.counter,
              updatedAt: new Date(),
            })
            .where(eq(admin.id, adminRecord.id));
        }
        return true;
      }
    }
    return false;
  }

  /** Record one admin-password failure for the account, then throw. Surfaces RATE_LIMITED + the ban deadline the
   *  moment a tier trips (consistency with the password + OTP paths). */
  private failAdminPwd(account: string): never {
    const ban = this.bruteForce.registerFailure(
      BAN_DIM_ADMIN_PWD,
      account,
      ADMIN_PWD_STEPS,
    );
    throw new BusinessException(
      ban !== undefined
        ? BusinessCode.RATE_LIMITED
        : BusinessCode.INVALID_CREDENTIALS,
      ban !== undefined
        ? 'too many login attempts; try again later'
        : 'invalid credentials',
      HttpStatus.OK,
      ban !== undefined ? { bannedUntil: ban } : undefined,
    );
  }

  /** Record one admin-2FA failure for the account, then throw. Collapses every post-lock failure to RATE_LIMITED
   *  (no expired/consumed distinction under a lock, same as the OTP path). */
  private failAdmin2FA(account: string): never {
    const ban = this.bruteForce.registerFailure(
      BAN_DIM_ADMIN_2FA,
      account,
      ADMIN_2FA_STEPS,
    );
    throw new BusinessException(
      ban !== undefined
        ? BusinessCode.RATE_LIMITED
        : BusinessCode.TWO_FACTOR_INVALID,
      ban !== undefined
        ? 'too many code attempts; try again later'
        : 'invalid verification code',
      HttpStatus.OK,
      ban !== undefined ? { bannedUntil: ban } : undefined,
    );
  }

  /** Record lastLogin (shared by the password-only and 2FA-verified login completions). */
  private async completeLogin(adminId: number, ip?: string): Promise<void> {
    await this.database.db
      .update(admin)
      .set({
        lastLoginAt: new Date(),
        lastLoginIp: ip ?? null,
        updatedAt: new Date(),
      })
      .where(eq(admin.id, adminId));
  }

  async revokeSessionsByAdmin(adminId: number, reason: string): Promise<void> {
    await this.database.db
      .update(adminSession)
      .set({ revokedAt: new Date(), revokeReason: reason })
      .where(
        and(eq(adminSession.adminId, adminId), isNull(adminSession.revokedAt)),
      );
  }

  async createAdminSession(
    adminId: number,
    opts: AdminSessionOpts = {},
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.database.db.insert(adminSession).values({
      adminId,
      tokenHash: hashToken(token),
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
      expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL_MS),
    });
    return token;
  }

  async validateAdminSession(
    token: string,
    ip?: string,
  ): Promise<{
    userId: number;
    adminId: number;
    role: AdminRole;
    sessionId: number;
  } | null> {
    const rec = await this.database.db.query.adminSession.findFirst({
      where: eq(adminSession.tokenHash, hashToken(token)),
      columns: {
        id: true,
        adminId: true,
        revokedAt: true,
        expiresAt: true,
        lastAccessedAt: true,
      },
      with: {
        admin: { columns: { userId: true, enabled: true, role: true } },
      },
    });
    if (
      !rec ||
      rec.revokedAt ||
      rec.expiresAt <= new Date() ||
      !rec.admin.enabled ||
      (ADMIN_SESSION_IDLE_MS !== null &&
        Date.now() - rec.lastAccessedAt.getTime() > ADMIN_SESSION_IDLE_MS)
    )
      return null;
    if (Date.now() - rec.lastAccessedAt.getTime() >= 5 * 60 * 1000) {
      await this.database.db
        .update(adminSession)
        .set({
          lastAccessedAt: new Date(),
          ...(ip === undefined ? {} : { ip }),
        })
        .where(
          and(eq(adminSession.id, rec.id), isNull(adminSession.revokedAt)),
        );
    }
    return {
      userId: rec.admin.userId,
      adminId: rec.adminId,
      role: rec.admin.role,
      sessionId: Number(rec.id),
    };
  }

  async revokeAdminSessionToken(token: string) {
    await this.database.db
      .update(adminSession)
      .set({ revokedAt: new Date(), revokeReason: 'logout' })
      .where(
        and(
          eq(adminSession.tokenHash, hashToken(token)),
          isNull(adminSession.revokedAt),
        ),
      );
  }

  // ── Admin session reads + identity (moved from AdminController) ──────────────
  // Owns the AdminRefreshToken table. Services return domain data; the controller wraps the envelope.

  /** Active admin refresh-session list (joins Admin → linked user account for display). */
  async listAdminSessions(opts: { skip?: number; take?: number; ip?: string }) {
    const where = and(
      isNull(adminSession.revokedAt),
      gt(adminSession.expiresAt, new Date()),
      opts.ip ? like(adminSession.ip, `%${opts.ip}%`) : undefined,
    );
    const [rows, total] = await Promise.all([
      this.database.db
        .select({
          adminId: adminSession.adminId,
          id: adminSession.id,
          userAgent: adminSession.userAgent,
          ip: adminSession.ip,
          createdAt: adminSession.createdAt,
          lastAccessedAt: adminSession.lastAccessedAt,
          expiresAt: adminSession.expiresAt,
          account: user.account,
        })
        .from(adminSession)
        .innerJoin(admin, eq(admin.id, adminSession.adminId))
        .innerJoin(user, eq(user.id, admin.userId))
        .where(where)
        .orderBy(desc(adminSession.createdAt))
        .offset(opts.skip ?? 0)
        .limit(opts.take ?? 50),
      this.database.db
        .select({ value: count() })
        .from(adminSession)
        .where(where)
        .then(([row]) => row.value),
    ]);
    // Flatten admin.user.account → admin.account so the shape matches the user-session list.
    const list = rows.map(({ account, ...r }) => ({
      ...r,
      id: r.id.toString(),
      admin: { id: r.adminId, account },
    }));
    return { list, total };
  }

  /** Revoke a single admin session by jti (its access token stays valid for up to the access TTL). */
  async revokeAdminSession(id: string): Promise<void> {
    await this.database.db
      .update(adminSession)
      .set({ revokedAt: new Date(), revokeReason: 'admin_revoke' })
      .where(
        and(eq(adminSession.id, BigInt(id)), isNull(adminSession.revokedAt)),
      );
  }

  /** Current admin identity for the console header + role gating. null when the profile is gone. */
  async me(
    adminId: number,
  ): Promise<{ account: string; name: string; role: AdminRole } | null> {
    const adminRow = await this.database.db.query.admin.findFirst({
      where: eq(admin.id, adminId),
      columns: { role: true },
      with: { user: { columns: { account: true, name: true } } },
    });
    if (!adminRow) return null;
    return {
      account: adminRow.user.account,
      name: adminRow.user.name,
      role: adminRow.role,
    };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
