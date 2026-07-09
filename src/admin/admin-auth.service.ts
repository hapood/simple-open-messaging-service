import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma.service.js';
import { jwtConstants } from '../auth/constants.js';

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
      where: { account_domain: { account, domain: 'local' } },
    });
    if (!user || user.isDeleted) return undefined;
    const admin = await this.prisma.admin.findUnique({ where: { userId: user.id } });
    if (!admin || !admin.enabled) return undefined;
    if (!(await argon2.verify(user.hashPwd, password))) return undefined;
    await this.prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date(), lastLoginIp: ip ?? null },
    });
    return {
      access_token: this.getAdminAccessToken(admin.id),
      refresh_token: await this.getAdminRefreshToken(admin.id, { ip }),
    };
  }

  getAdminAccessToken(adminId: number) {
    return this.jwtService.sign(
      { sub: adminId, scope: 'admin' },
      { secret: jwtConstants.adminSecret, expiresIn: jwtConstants.accessTtl },
    );
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
      access: this.getAdminAccessToken(v.adminId),
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
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
