import { Injectable, HttpStatus } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma.service.js';
import { jwtConstants } from '../auth/constants.js';
import { normalizeAccount } from '../common/account.js';
import { AdminRole } from '../prisma/generated/client.js';
import {
  BruteForceService,
  BAN_DIM_ADMIN_PWD,
  BAN_DIM_ADMIN_2FA,
  type BanStep,
} from '../auth/brute-force.service.js';
import { PasswordHasher } from '../auth/password-hasher.service.js';
import { TwoFactorService, type SetupBundle } from './two-factor.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

/**
 * Admin auth service: mirrors AuthService's family-based + reuse-detection algorithm. Identity (account + password)
 * lives on the linked User; this service operates on the separate Admin/AdminRefreshToken tables and signs tokens with
 * a separate adminSecret carrying scope:'admin' (physically isolated from user auth — the two never interoperate).
 */
type AdminVerifyResult =
  | { ok: true; adminId: number; familyId: string; jti: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'reuse' };

type AdminRefreshOpts = { familyId?: string; ip?: string; userAgent?: string };

/** Account-dimension progressive-ban steps for admin password login (the IP ceiling is the route @Throttle).
 *  Same shape as the user-side password path: escalating lockouts, sliding 15-min window in BruteForceService. */
const ADMIN_PWD_STEPS: readonly BanStep[] = [
  { count: 5, banMs: 30 * 60 * 1000 },
  { count: 10, banMs: 3 * 60 * 60 * 1000 },
  { count: 20, banMs: 24 * 60 * 60 * 1000 },
];
/** Account-dimension brute-force ceiling on the 6-digit TOTP / 8-char backup code (mirrors OtpLoginService:
 *  the 10^6 code space can't be exhausted once ≤5 guesses/window are allowed). */
const ADMIN_2FA_STEPS: readonly BanStep[] = [{ count: 5, banMs: 30 * 60 * 1000 }];

/** Login outcome: either the token pair, or a 2FA challenge (password verified → no tokens yet). */
export type AdminLoginResult =
  | { access_token: string; refresh_token: string }
  | { twoFactorRequired: true; challengeToken: string };

@Injectable()
export class AdminAuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private bruteForce: BruteForceService,
    private twoFactor: TwoFactorService,
    private passwordHasher: PasswordHasher,
  ) {}

  /** Admin login: identity is on the linked User (single account namespace) → verify User.hashPwd → require an
   *  enabled Admin profile. When 2FA is enrolled, the password verifying issues a short-lived CHALLENGE token (no
   *  session yet); /admin/login/verify completes login after the TOTP/backup code. Account-dimension progressive
   *  banning lives in BruteForceService (the IP ceiling is the route @Throttle); a wrong password throws
   *  INVALID_CREDENTIALS (or RATE_LIMITED once the threshold trips). */
  async login(account: string, password: string, ip?: string): Promise<AdminLoginResult> {
    const acct = normalizeAccount(account);
    // Pre-check the account-dimension lock before the (slow) argon2 verify. The IP ceiling is @Throttle(5,60).
    const ban = this.bruteForce.activeBanUntil([{ dimension: BAN_DIM_ADMIN_PWD, value: acct }]);
    if (ban !== undefined) {
      throw new BusinessException(
        BusinessCode.RATE_LIMITED,
        'too many login attempts; try again later',
        HttpStatus.OK,
        { bannedUntil: ban },
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { account_domain: { account: acct, domain: 'local' } },
    });
    // Non-revealing: a missing / deleted / group identity, no admin profile, a disabled admin, a no-password
    // account, or a wrong password are all indistinguishable from the caller's view (INVALID_CREDENTIALS).
    // NOT counted when there is no real enabled admin to protect (avoids filling the failure map with noise).
    const admin =
      user && !user.isDeleted && !user.isGroup
        ? await this.prisma.admin.findUnique({ where: { userId: user.id } })
        : null;
    const passwordOk =
      !!admin &&
      admin.enabled &&
      !!user &&
      !!user.hashPwd &&
      (await this.passwordHasher.verify(user.hashPwd, password));
    if (!passwordOk || !admin) {
      if (admin) {
        // Real enabled admin + wrong password → count toward the progressive lock.
        this.failAdminPwd(acct);
      }
      throw new BusinessException(
        BusinessCode.INVALID_CREDENTIALS,
        'invalid credentials',
        HttpStatus.OK,
      );
    }

    // Password verified. Branch: 2FA-enrolled → challenge; otherwise issue the session right away.
    if (admin.twoFactorEnabled) {
      return { twoFactorRequired: true, challengeToken: this.twoFactor.signChallenge(admin.id) };
    }
    await this.completeLogin(admin.id, ip);
    return {
      access_token: await this.getAdminAccessToken(admin.id),
      refresh_token: await this.getAdminRefreshToken(admin.id, { ip }),
    };
  }

  /** Complete a 2FA login: verify the challenge token, check the account lock, validate the TOTP (with the
   *  same-window replay guard) OR consume a backup code, then issue the session. Throws on any failure. */
  async verifyLogin(
    challengeToken: string,
    code: string | undefined,
    backupCode: string | undefined,
    ip?: string,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const adminId = this.twoFactor.verifyChallenge(challengeToken);
    if (adminId === null) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_CHALLENGE_EXPIRED,
        'login session expired; please sign in again',
        HttpStatus.OK,
      );
    }
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        enabled: true,
        twoFactorEnabled: true,
        twoFactorSecretCipher: true,
        twoFactorLastUsedCounter: true,
        user: { select: { account: true } },
      },
    });
    // 2FA disabled / admin gone mid-challenge → the admin must restart login (no session to leak).
    if (!admin || !admin.enabled || !admin.twoFactorEnabled || !admin.twoFactorSecretCipher) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_NOT_ENABLED,
        'two-factor is not enabled for this account',
        HttpStatus.OK,
      );
    }
    const acct = admin.user.account;
    const ban = this.bruteForce.activeBanUntil([{ dimension: BAN_DIM_ADMIN_2FA, value: acct }]);
    if (ban !== undefined) {
      throw new BusinessException(
        BusinessCode.RATE_LIMITED,
        'too many code attempts; try again later',
        HttpStatus.OK,
        { bannedUntil: ban },
      );
    }

    const passed = await this.verifyFactor(admin, code, backupCode, /*advanceCounter*/ true);
    if (!passed) this.failAdmin2FA(acct);

    this.bruteForce.clearFailures(BAN_DIM_ADMIN_2FA, acct);
    await this.completeLogin(admin.id, ip);
    return {
      access_token: await this.getAdminAccessToken(admin.id),
      refresh_token: await this.getAdminRefreshToken(admin.id, { ip }),
    };
  }

  // ── Two-factor enrollment + management (self-service; the caller is the authenticated admin) ──────

  /** Begin 2FA enrollment: mint a secret + provisioning URI + a signed pending token (stateless — no DB write
   *  until the admin confirms with their first code). Refuses if already enrolled. */
  async beginTwoFactorSetup(adminId: number): Promise<SetupBundle> {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
      select: { twoFactorEnabled: true, user: { select: { account: true, name: true } } },
    });
    if (!admin) throw new BusinessException(BusinessCode.NOT_FOUND, 'admin not found', HttpStatus.OK);
    if (admin.twoFactorEnabled) {
      throw new BusinessException(
        BusinessCode.TWO_FACTOR_ALREADY_ENABLED,
        'two-factor is already enabled; disable it first to re-enroll',
        HttpStatus.OK,
      );
    }
    return this.twoFactor.beginSetup(adminId, admin.user.account, admin.user.name);
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
      throw new BusinessException(BusinessCode.TWO_FACTOR_INVALID, 'invalid verification code', HttpStatus.OK);
    }
    const { backupCodes } = await this.twoFactor.enableWithBackupCodes(adminId, pending.secret);
    // enableWithBackupCodes already bumped tokenVersion atomically (so no 2FA-bypassing session can exist);
    // revoke the refresh families best-effort so the re-login is immediate rather than waiting for the
    // access TTL. The admin just proved enrollment, so the forced re-login is expected.
    await this.revokeRefreshByAdmin(adminId, '2fa_enabled').catch(() => {
      /* best-effort: access tokens are already invalidated by the in-tx tokenVersion bump */
    });
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
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        twoFactorEnabled: true,
        twoFactorSecretCipher: true,
        twoFactorLastUsedCounter: true,
        user: { select: { account: true, hashPwd: true } },
      },
    });
    if (!admin) throw new BusinessException(BusinessCode.NOT_FOUND, 'admin not found', HttpStatus.OK);
    if (!admin.twoFactorEnabled) {
      throw new BusinessException(BusinessCode.TWO_FACTOR_NOT_ENABLED, 'two-factor is not enabled', HttpStatus.OK);
    }
    const acct = admin.user.account;
    if (!admin.user.hashPwd || !(await this.passwordHasher.verify(admin.user.hashPwd, password))) {
      throw new BusinessException(BusinessCode.INVALID_CREDENTIALS, 'invalid credentials', HttpStatus.OK);
    }
    // A wrong 2FA factor counts toward the lock (same surface as login verify).
    if (!(await this.verifyFactor(admin, code, backupCode, /*advanceCounter*/ false))) {
      this.failAdmin2FA(acct);
    }
    await this.twoFactor.disable(adminId);
  }

  /** Regenerate the backup-code set (requires a live TOTP or backup code). Returns the new codes plaintext ONCE. */
  async regenerateBackupCodes(
    adminId: number,
    code: string | undefined,
    backupCode: string | undefined,
  ): Promise<{ backupCodes: string[] }> {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        twoFactorEnabled: true,
        twoFactorSecretCipher: true,
        twoFactorLastUsedCounter: true,
        user: { select: { account: true } },
      },
    });
    if (!admin || !admin.twoFactorEnabled || !admin.twoFactorSecretCipher) {
      throw new BusinessException(BusinessCode.TWO_FACTOR_NOT_ENABLED, 'two-factor is not enabled', HttpStatus.OK);
    }
    const acct = admin.user.account;
    if (!(await this.verifyFactor(admin, code, backupCode, /*advanceCounter*/ false))) {
      this.failAdmin2FA(acct);
    }
    return this.twoFactor.regenerateBackupCodes(adminId);
  }

  /** 2FA status for the security card. */
  async twoFactorStatus(
    adminId: number,
  ): Promise<{ enabled: boolean; enabledAt: Date | null; backupCodesRemaining: number }> {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
      select: { twoFactorEnabled: true, twoFactorEnabledAt: true },
    });
    if (!admin) throw new BusinessException(BusinessCode.NOT_FOUND, 'admin not found', HttpStatus.OK);
    return {
      enabled: admin.twoFactorEnabled,
      enabledAt: admin.twoFactorEnabledAt,
      backupCodesRemaining: admin.twoFactorEnabled
        ? await this.twoFactor.remainingBackupCodes(adminId)
        : 0,
    };
  }

  /** SUPER_ADMIN lockout-recovery: clear another admin's 2FA outright (no code required — gated by the
   *  SUPER_ADMIN role at the controller, and audited). Idempotent. Does not touch sessions (a locked-out
   *  admin has no live session anyway). */
  async resetTwoFactorBySuper(targetAdminId: number): Promise<void> {
    const admin = await this.prisma.admin.findUnique({
      where: { id: targetAdminId },
      select: { twoFactorEnabled: true },
    });
    if (!admin) throw new BusinessException(BusinessCode.NOT_FOUND, 'admin not found', HttpStatus.OK);
    if (!admin.twoFactorEnabled) return; // nothing to reset
    await this.twoFactor.disable(targetAdminId);
  }

  // ── 2FA helpers ───────────────────────────────────────────────────────────────

  /** Validate a 2FA factor against an admin: a TOTP code (optionally advancing the replay counter) OR a backup
   *  code (consumed on success). Returns false (no throw) on mismatch so the caller can apply brute-force. */
  private async verifyFactor(
    admin: {
      id: number;
      twoFactorSecretCipher: string | null;
      twoFactorLastUsedCounter: number | null;
    },
    code: string | undefined,
    backupCode: string | undefined,
    advanceCounter: boolean,
  ): Promise<boolean> {
    if (backupCode) return this.twoFactor.consumeBackupCode(admin.id, backupCode);
    if (code && admin.twoFactorSecretCipher) {
      const secret = this.twoFactor.decryptSecret(admin.twoFactorSecretCipher);
      const check = this.twoFactor.verifyTotp(secret, code, admin.twoFactorLastUsedCounter);
      if (check.ok) {
        if (advanceCounter) {
          await this.prisma.admin.update({
            where: { id: admin.id },
            data: { twoFactorLastUsedCounter: check.counter },
          });
        }
        return true;
      }
    }
    return false;
  }

  /** Record one admin-password failure for the account, then throw. Surfaces RATE_LIMITED + the ban deadline the
   *  moment a tier trips (consistency with the password + OTP paths). */
  private failAdminPwd(account: string): never {
    const ban = this.bruteForce.registerFailure(BAN_DIM_ADMIN_PWD, account, ADMIN_PWD_STEPS);
    throw new BusinessException(
      ban !== undefined ? BusinessCode.RATE_LIMITED : BusinessCode.INVALID_CREDENTIALS,
      ban !== undefined ? 'too many login attempts; try again later' : 'invalid credentials',
      HttpStatus.OK,
      ban !== undefined ? { bannedUntil: ban } : undefined,
    );
  }

  /** Record one admin-2FA failure for the account, then throw. Collapses every post-lock failure to RATE_LIMITED
   *  (no expired/consumed distinction under a lock, same as the OTP path). */
  private failAdmin2FA(account: string): never {
    const ban = this.bruteForce.registerFailure(BAN_DIM_ADMIN_2FA, account, ADMIN_2FA_STEPS);
    throw new BusinessException(
      ban !== undefined ? BusinessCode.RATE_LIMITED : BusinessCode.TWO_FACTOR_INVALID,
      ban !== undefined ? 'too many code attempts; try again later' : 'invalid verification code',
      HttpStatus.OK,
      ban !== undefined ? { bannedUntil: ban } : undefined,
    );
  }

  /** Record lastLogin (shared by the password-only and 2FA-verified login completions). */
  private async completeLogin(adminId: number, ip?: string): Promise<void> {
    await this.prisma.admin.update({
      where: { id: adminId },
      data: { lastLoginAt: new Date(), lastLoginIp: ip ?? null },
    });
  }

  /**
   * Issue an admin access token carrying tver = Admin.tokenVersion at issue time. AdminJwtStrategy
   * verifies tver matches the current value, so bumping tokenVersion (invalidateAllAdminSessions)
   * invalidates every outstanding access token on its next request. Mirrors the user-side access token.
   */
  async getAdminAccessToken(adminId: number) {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
      select: { tokenVersion: true },
    });
    return this.jwtService.sign(
      { sub: adminId, tver: admin!.tokenVersion, scope: 'admin' },
      { secret: jwtConstants.adminSecret, expiresIn: jwtConstants.accessTtl },
    );
  }

  /**
   * Disable / role change / force-kick an admin: revoke every active admin refresh token AND bump
   * tokenVersion so all access tokens fail their next tver check (immediate — no 15m lag). Mirrors the
   * user-side AuthService.invalidateAllSessions, minus the KV-store tver cache + WS FORCE_LOGOUT (admins
   * have no WS client and admin request volume is low, so the strategy reads tokenVersion from the DB
   * directly).
   */
  /** Revoke every outstanding refresh token for an admin (marks the active family revokedAt + reason).
   *  Split out of invalidateAllAdminSessions so callers that bump tokenVersion INSIDE a transaction
   *  (AdminManageService.disable / setRole — the last-super guard) can revoke refresh afterwards
   *  without issuing a second write against the Admin row. */
  async revokeRefreshByAdmin(adminId: number, reason: string): Promise<void> {
    await this.prisma.adminRefreshToken.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  /** NOT atomic across the two writes. Callers needing the tokenVersion bump inside the same
   *  transaction as a guarded state change (the last-super guard) must bump inside their own
   *  $transaction and call revokeRefreshByAdmin separately — see AdminManageService.guardedStateChange. */
  async invalidateAllAdminSessions(adminId: number, reason: string): Promise<void> {
    await this.revokeRefreshByAdmin(adminId, reason);
    await this.prisma.admin.update({
      where: { id: adminId },
      data: { tokenVersion: { increment: 1 } },
    });
  }

  async getAdminRefreshToken(adminId: number, opts: AdminRefreshOpts = {}) {
    const familyId = opts.familyId ?? randomUUID();
    const jti = randomUUID();
    const token = this.jwtService.sign(
      { sub: adminId, jti, fam: familyId, scope: 'admin' },
      { secret: jwtConstants.adminSecret, expiresIn: jwtConstants.refreshTtlDays },
    );
    await this.prisma.adminRefreshToken.create({
      data: {
        adminId,
        tokenHash: hashToken(token),
        jti,
        familyId,
        ip: opts.ip ?? null,
        userAgent: opts.userAgent ?? null,
        expiresAt: new Date(Date.now() + jwtConstants.refreshTtlMs),
      },
    });
    return token;
  }

  async verifyAdminRefreshToken(token: string): Promise<AdminVerifyResult> {
    try {
      this.jwtService.verify(token, { secret: jwtConstants.adminSecret });
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    const rec = await this.prisma.adminRefreshToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        adminId: true,
        familyId: true,
        jti: true,
        revokedAt: true,
        expiresAt: true,
      },
    });
    if (!rec) return { ok: false, reason: 'invalid' };
    if (rec.revokedAt !== null) {
      await this.revokeAdminFamily(rec.familyId, 'reuse');
      return { ok: false, reason: 'reuse' };
    }
    if (rec.expiresAt <= new Date()) return { ok: false, reason: 'expired' };
    return { ok: true, adminId: rec.adminId, familyId: rec.familyId, jti: rec.jti };
  }

  async rotateAdminRefreshToken(token: string, opts: AdminRefreshOpts = {}) {
    const v = await this.verifyAdminRefreshToken(token);
    if (v.ok === false) throw v.reason;
    const claim = await this.prisma.adminRefreshToken.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'rotated' },
    });
    if (claim.count === 0) {
      await this.revokeAdminFamily(v.familyId, 'reuse');
      throw 'reuse';
    }
    const refresh = await this.getAdminRefreshToken(v.adminId, {
      familyId: v.familyId,
      ...opts,
    });
    return {
      access: await this.getAdminAccessToken(v.adminId),
      refresh,
      adminId: v.adminId,
    };
  }

  async revokeAdminFamily(familyId: string, reason: string) {
    await this.prisma.adminRefreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  }

  async revokeAdminRefreshToken(token: string) {
    await this.prisma.adminRefreshToken.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'logout' },
    });
  }

  // ── Admin session reads + identity (moved from AdminController) ──────────────
  // Owns the AdminRefreshToken table. Services return domain data; the controller wraps the envelope.

  /** Active admin refresh-session list (joins Admin → linked user account for display). */
  async listAdminSessions(opts: { skip?: number; take?: number; ip?: string }) {
    const where = {
      revokedAt: null,
      expiresAt: { gt: new Date() },
      ...(opts.ip ? { ip: { contains: opts.ip } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.adminRefreshToken.findMany({
        where,
        skip: opts.skip ?? 0,
        take: opts.take ?? 50,
        orderBy: { createdAt: 'desc' },
        select: {
          adminId: true,
          jti: true,
          userAgent: true,
          ip: true,
          createdAt: true,
          expiresAt: true,
          admin: { select: { id: true, user: { select: { account: true } } } },
        },
      }),
      this.prisma.adminRefreshToken.count({ where }),
    ]);
    // Flatten admin.user.account → admin.account so the shape matches the user-session list.
    const list = rows.map((r) => ({
      ...r,
      admin: { id: r.admin.id, account: r.admin.user.account },
    }));
    return { list, total };
  }

  /** Revoke a single admin session by jti (its access token stays valid for up to the access TTL). */
  async revokeAdminSession(jti: string): Promise<void> {
    await this.prisma.adminRefreshToken.updateMany({
      where: { jti, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'admin_revoke' },
    });
  }

  /** Current admin identity for the console header + role gating. null when the profile is gone. */
  async me(adminId: number): Promise<{ account: string; name: string; role: AdminRole } | null> {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
      select: { role: true, user: { select: { account: true, name: true } } },
    });
    if (!admin) return null;
    return { account: admin.user.account, name: admin.user.name, role: admin.role };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
