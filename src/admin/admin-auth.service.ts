import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma.service.js';
import { jwtConstants } from '../auth/constants.js';
import { normalizeAccount } from '../common/account.js';
import { AdminRole } from '../prisma/generated/client.js';

/**
 * Admin auth service: mirrors AuthService's family-based + reuse-detection algorithm. Identity (account + password)
 * lives on the linked User; this service operates on the separate Admin/AdminRefreshToken tables and signs tokens with
 * a separate adminSecret carrying scope:'admin' (physically isolated from user auth — the two never interoperate).
 */
type AdminVerifyResult =
  | { ok: true; adminId: number; familyId: string; jti: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'reuse' };

type AdminRefreshOpts = { familyId?: string; ip?: string; userAgent?: string };

@Injectable()
export class AdminAuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  /** Admin login: identity is on the linked User (single account namespace) → verify User.hashPwd → require an
   *  enabled Admin profile → sign access + refresh (new family), record lastLogin. Returns undefined on failure.
   *  The Admin table no longer holds account/password. */
  async login(account: string, password: string, ip?: string) {
    const user = await this.prisma.user.findUnique({
      where: { account_domain: { account: normalizeAccount(account), domain: 'local' } },
    });
    if (!user || user.isDeleted || user.isGroup) return undefined;
    const admin = await this.prisma.admin.findUnique({ where: { userId: user.id } });
    if (!admin || !admin.enabled) return undefined;
    if (!(await argon2.verify(user.hashPwd, password))) return undefined;
    await this.prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date(), lastLoginIp: ip ?? null },
    });
    return {
      access_token: await this.getAdminAccessToken(admin.id),
      refresh_token: await this.getAdminRefreshToken(admin.id, { ip }),
    };
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
