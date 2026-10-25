import { accountProfileFields } from '../user/account-profile.js';
import { Injectable, HttpStatus, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, createHmac, randomBytes } from 'crypto';
import { and, count, desc, eq, gt, isNull, like } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  admin,
  adminSession,
  adminLoginChallenge,
  systemSetting,
  account as user,
} from '../database/schema.js';
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
import { TwoFactorService } from './two-factor.service.js';
import {
  WebAuthnService,
  type WebAuthnCredentialView,
} from './webauthn.service.js';
import { type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { WEBAUTHN_CONFIG } from './webauthn.config.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { AdminPrincipal } from './admin-session.js';

/**
 * Admin auth service: opaque admin sessions persisted in the separate AdminSession table (token-hashed,
 * independently revocable). Identity (account + password) lives on the linked User; the only JWT is the
 * single-use 2FA/WebAuthn login-challenge token, signed with a separate adminSecret (physically isolated
 * from user auth — the two never interoperate).
 */
type AdminSessionOpts = { ip?: string; userAgent?: string };

const ADMIN_SESSION_POLICY_KEY = 'admin:sessionPolicy';

function parseAdminSessionPolicy(raw: string) {
  return validateAdminSessionPolicy(JSON.parse(raw) as Record<string, unknown>);
}

function validateAdminSessionPolicy(input: Record<string, unknown>) {
  const ttlHours = input.ttlHours;
  const idleMinutes = input.idleMinutes;
  if (
    !Number.isInteger(ttlHours) ||
    (ttlHours as number) < 1 ||
    (ttlHours as number) > 24
  )
    throw new Error('ttlHours must be an integer from 1 to 24');
  if (
    !Number.isInteger(idleMinutes) ||
    (idleMinutes as number) < 0 ||
    (idleMinutes as number) > 8 * 60 ||
    ((idleMinutes as number) > 0 && (idleMinutes as number) < 15)
  )
    throw new Error('idleMinutes must be 0 or an integer from 15 to 480');
  return { ttlHours: ttlHours as number, idleMinutes: idleMinutes as number };
}

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
export class AdminAuthService implements OnModuleInit {
  private sessionPolicy = { ttlHours: 12, idleMinutes: 60 };
  /** Coalesce activity writes within this process, without caching authentication state. */
  private readonly activityWrites = new Map<bigint, Promise<void>>();
  constructor(
    private database: DatabaseService,
    private jwtService: JwtService,
    private bruteForce: BruteForceService,
    private twoFactor: TwoFactorService,
    private passwordHasher: PasswordHasher,
    private webAuthn: WebAuthnService,
  ) {}

  async onModuleInit(): Promise<void> {
    const row = await this.database.db.query.systemSetting.findFirst({
      where: eq(systemSetting.key, ADMIN_SESSION_POLICY_KEY),
    });
    if (row) this.sessionPolicy = parseAdminSessionPolicy(row.value);
  }

  getSessionPolicy() {
    return { ...this.sessionPolicy };
  }

  get sessionTtlMs(): number {
    return this.sessionPolicy.ttlHours * 60 * 60 * 1000;
  }

  private get sessionIdleMs(): number | null {
    return this.sessionPolicy.idleMinutes === 0
      ? null
      : this.sessionPolicy.idleMinutes * 60 * 1000;
  }

  async setSessionPolicy(input: Record<string, unknown>) {
    const policy = validateAdminSessionPolicy(input);
    const value = JSON.stringify(policy);
    await this.database.db
      .insert(systemSetting)
      .values({ key: ADMIN_SESSION_POLICY_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: systemSetting.key,
        set: { value, updatedAt: new Date() },
      });
    this.sessionPolicy = policy;
    return this.getSessionPolicy();
  }

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
    // Pre-check the account-dimension lock before the slow argon2 verify. A named fixed-window policy
    // supplies the separate IP ceiling at the controller boundary.
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
    const [userRow] = await this.database.db
      .select({
        id: user.id,
        hashPwd: user.hashPwd,
        updatedAt: user.updatedAt,
        disabledAt: user.disabledAt,
        availability: user.availability,
      })
      .from(user)
      .where(and(eq(user.account, acct), eq(user.namespaceId, 0)))
      .limit(1);
    // Non-revealing: a missing / deleted / group identity, no admin profile, a disabled admin, a no-password
    // account, or a wrong password are all indistinguishable from the caller's view (INVALID_CREDENTIALS).
    // NOT counted when there is no real enabled admin to protect (avoids filling the failure map with noise).
    const adminProfile = userRow
      ? await this.database.db.query.admin.findFirst({
          where: eq(admin.userId, userRow.id),
        })
      : null;
    const loginState =
      userRow && adminProfile
        ? this.stateDigest(userRow.hashPwd, adminProfile, userRow.updatedAt)
        : undefined;
    const passwordOk =
      !!adminProfile &&
      adminProfile.enabled &&
      !!userRow &&
      userRow.disabledAt == null &&
      userRow.availability !== 'REMOVED' &&
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
        challengeToken: await this.twoFactor.signChallenge(
          adminProfile.id,
          loginState,
        ),
        factors: { totp: hasTotp, webauthn: hasWebauthn },
      };
    }
    await this.completeLogin(adminProfile.id, ip);
    return {
      sessionToken: await this.createAdminSession(
        adminProfile.id,
        {
          ip,
          userAgent,
        },
        loginState,
      ),
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
      with: { account: { columns: { account: true } } },
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
    const acct = adminRow.account.account;
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
      sessionToken: await this.createAdminSession(
        adminRow.id,
        {
          ip,
          userAgent,
        },
        decoded.state,
        jti,
      ),
    };
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
    await this.database.db.transaction(async (tx) => {
      const owner = await tx.query.admin.findFirst({
        where: eq(admin.id, targetAdminId),
        columns: { userId: true },
      });
      if (!owner)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'admin not found');
      await tx
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, owner.userId))
        .for('no key update');
      const [row] = await tx
        .select()
        .from(admin)
        .where(eq(admin.id, targetAdminId))
        .for('no key update');
      if (row.role === AdminRole.SUPER_ADMIN)
        throw new BusinessException(
          BusinessCode.FORBIDDEN,
          'super-admin security must be managed by its owner',
        );
      if (!row.twoFactorEnabled) return;
      await this.twoFactor.disable(targetAdminId, tx);
      await tx
        .update(user)
        .set({ updatedAt: new Date() })
        .where(eq(user.id, owner.userId));
      await tx
        .update(adminSession)
        .set({ revokedAt: new Date(), revokeReason: '2fa_reset' })
        .where(
          and(
            eq(adminSession.adminId, targetAdminId),
            isNull(adminSession.revokedAt),
          ),
        );
      await tx
        .delete(adminLoginChallenge)
        .where(eq(adminLoginChallenge.adminId, targetAdminId));
    });
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
      with: { account: { columns: { account: true } } },
    });
    if (!adminRow || !adminRow.enabled || !adminRow.webauthnEnabled) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_NOT_ENABLED,
        'no passkey is enabled for this account',
        HttpStatus.OK,
      );
    }
    const ban = this.bruteForce.activeBanUntil([
      { dimension: BAN_DIM_ADMIN_2FA, value: adminRow.account.account },
    ]);
    if (ban !== undefined) {
      throw new BusinessException(
        BusinessCode.RATE_LIMITED,
        'too many code attempts; try again later',
        HttpStatus.OK,
        { bannedUntil: ban },
      );
    }
    return this.webAuthn.beginAssertion(adminId, decoded.jti);
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
      with: { account: { columns: { account: true } } },
    });
    if (!adminRow || !adminRow.enabled) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_NOT_ENABLED,
        'account is not available',
        HttpStatus.OK,
      );
    }
    const acct = adminRow.account.account;
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
      jti,
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
      sessionToken: await this.createAdminSession(
        adminId,
        { ip, userAgent },
        decoded.state,
        jti,
      ),
    };
  }

  // ── WebAuthn enrollment + management (self-service; caller is the authenticated admin) ──────────

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
          const rows = await this.database.db
            .update(admin)
            .set({ twoFactorLastUsedCounter: check.counter })
            .where(
              and(
                eq(admin.id, adminRecord.id),
                eq(admin.twoFactorEnabled, true),
                eq(
                  admin.twoFactorSecretCipher,
                  adminRecord.twoFactorSecretCipher,
                ),
                adminRecord.twoFactorLastUsedCounter === null
                  ? isNull(admin.twoFactorLastUsedCounter)
                  : eq(
                      admin.twoFactorLastUsedCounter,
                      adminRecord.twoFactorLastUsedCounter,
                    ),
              ),
            )
            .returning({ id: admin.id });
          if (rows.length !== 1) return false;
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

  private stateDigest(
    hash: string | null,
    row: Pick<
      typeof admin.$inferSelect,
      'twoFactorEnabled' | 'twoFactorSecretCipher' | 'webauthnEnabled'
    >,
    updatedAt?: Date,
  ) {
    return createHmac('sha256', jwtConstants.adminSecret)
      .update(
        JSON.stringify([
          hash,
          row.twoFactorEnabled,
          row.twoFactorSecretCipher,
          row.webauthnEnabled,
          updatedAt,
        ]),
      )
      .digest('base64url');
  }

  async createAdminSession(
    adminId: number,
    opts: AdminSessionOpts = {},
    expectedState?: string,
    challengeId?: string,
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.database.db.transaction(async (tx) => {
      const owner = await tx.query.admin.findFirst({
        where: eq(admin.id, adminId),
        columns: { userId: true },
      });
      if (!owner)
        throw new BusinessException(
          BusinessCode.UNAUTHENTICATED,
          'account unavailable',
        );
      const [account] = await tx
        .select()
        .from(user)
        .where(eq(user.id, owner.userId))
        .for('no key update');
      const [row] = await tx
        .select()
        .from(admin)
        .where(eq(admin.id, adminId))
        .for('no key update');
      if (
        !row?.enabled ||
        !account ||
        account.disabledAt != null ||
        account.availability === 'REMOVED' ||
        !expectedState ||
        this.stateDigest(account.hashPwd, row, account.updatedAt) !==
          expectedState
      )
        throw new BusinessException(
          BusinessCode.UNAUTHENTICATED,
          'authentication changed; sign in again',
        );
      if (challengeId) {
        const challenge = await tx.query.adminLoginChallenge.findFirst({
          where: and(
            eq(adminLoginChallenge.jti, challengeId),
            eq(adminLoginChallenge.adminId, adminId),
          ),
        });
        if (!challenge?.consumedAt)
          throw new BusinessException(
            BusinessCode.UNAUTHENTICATED,
            'authentication changed; sign in again',
          );
      }
      await tx.insert(adminSession).values({
        adminId,
        tokenHash: hashToken(token),
        ip: opts.ip ?? null,
        userAgent: opts.userAgent ?? null,
        expiresAt: new Date(Date.now() + this.sessionTtlMs),
      });
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
        admin: {
          columns: { userId: true, enabled: true, role: true },
          with: {
            account: { columns: { disabledAt: true, availability: true } },
          },
        },
      },
    });
    if (
      !rec ||
      rec.revokedAt ||
      rec.expiresAt <= new Date() ||
      !rec.admin.enabled ||
      !rec.admin.account ||
      rec.admin.account.disabledAt != null ||
      rec.admin.account.availability === 'REMOVED' ||
      (this.sessionIdleMs !== null &&
        Date.now() - rec.lastAccessedAt.getTime() > this.sessionIdleMs)
    )
      return null;
    if (Date.now() - rec.lastAccessedAt.getTime() >= 5 * 60 * 1000) {
      let write = this.activityWrites.get(rec.id);
      if (!write) {
        // Defer execution until the promise is registered, including synchronous failures.
        // Concurrent requests share the first writer's timestamp and IP.
        write = Promise.resolve()
          .then(async () => {
            await this.database.db
              .update(adminSession)
              .set({
                lastAccessedAt: new Date(),
                ...(ip === undefined ? {} : { ip }),
              })
              .where(
                and(
                  eq(adminSession.id, rec.id),
                  isNull(adminSession.revokedAt),
                ),
              );
          })
          .finally(() => {
            this.activityWrites.delete(rec.id);
          });
        this.activityWrites.set(rec.id, write);
      }
      await write;
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
  // Owns the AdminSession table. Services return domain data; the controller wraps the envelope.

  /** Active admin refresh-session list (joins Admin → linked user account for display). */
  async listAdminSessions(
    opts: { skip?: number; take?: number; ip?: string },
    actor: AdminPrincipal,
  ) {
    const where = and(
      isNull(adminSession.revokedAt),
      gt(adminSession.expiresAt, new Date()),
      eq(admin.enabled, true),
      this.sessionIdleMs === null
        ? undefined
        : gt(
            adminSession.lastAccessedAt,
            new Date(Date.now() - this.sessionIdleMs),
          ),
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
        .innerJoin(admin, eq(admin.id, adminSession.adminId))
        .where(where)
        .then(([row]) => row.value),
    ]);
    // Flatten admin.user.account → admin.account so the shape matches the user-session list.
    const list = rows.map(({ account, ...r }) => ({
      ...r,
      id: r.id.toString(),
      isCurrent: r.id === BigInt(actor.sessionId),
      canRevoke:
        r.id !== BigInt(actor.sessionId) &&
        (r.adminId === actor.adminId || actor.role === AdminRole.SUPER_ADMIN),
      admin: { id: r.adminId, account },
    }));
    return { list, total };
  }

  /** End another console session immediately; ownership is enforced in the write predicate. */
  async revokeAdminSession(id: string, actor: AdminPrincipal): Promise<void> {
    if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid session id',
      );
    }
    if (BigInt(id) === BigInt(actor.sessionId)) {
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'use logout for the current session',
      );
    }
    const [revoked] = await this.database.db
      .update(adminSession)
      .set({ revokedAt: new Date(), revokeReason: 'admin_revoke' })
      .where(
        and(
          eq(adminSession.id, BigInt(id)),
          isNull(adminSession.revokedAt),
          actor.role === AdminRole.SUPER_ADMIN
            ? undefined
            : eq(adminSession.adminId, actor.adminId),
        ),
      )
      .returning({ id: adminSession.id });
    if (!revoked) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'session unavailable or not permitted',
      );
    }
  }

  /** Current admin identity for the console header + role gating. null when the profile is gone. */
  async me(
    adminId: number,
  ): Promise<{ account: string; name: string; role: AdminRole } | null> {
    const adminRow = await this.database.db.query.admin.findFirst({
      where: eq(admin.id, adminId),
      columns: { role: true },
      with: {
        account: {
          columns: { account: true },
          extras: { name: accountProfileFields().name.as('name') },
        },
      },
    });
    if (!adminRow) return null;
    return {
      account: adminRow.account.account,
      name: adminRow.account.name,
      role: adminRow.role,
    };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
