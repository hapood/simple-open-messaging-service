import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import { jwtConstants } from '../auth/constants.js';
import { PrismaService } from '../prisma.service.js';
import { AdminRole } from '../prisma/generated/client.js';

/** Admin access-token claims. `tver` mirrors the user-side tokenVersion (added Phase 1). */
type AdminAccessPayload = { sub: number; scope?: string; tver?: number };

/** The principal AdminJwtStrategy attaches to `req.user` — read by AdminRolesGuard + AdminAuditInterceptor. */
export type AdminPrincipal = { adminId: number; role: AdminRole };

/**
 * Admin JWT strategy (isolated 'admin-jwt'): verifies the separate adminSecret AND requires
 * scope:'admin'. Loads the Admin row to enforce tokenVersion (global session revocation) + enabled,
 * and attaches the role for RBAC. Physically isolated from the user JwtStrategy — user tokens cannot
 * reach admin endpoints and vice versa.
 *
 * tver: a newly-issued admin access token carries tver = Admin.tokenVersion at issue time; bumping it
 * (disable / role change via AdminAuthService.invalidateAllAdminSessions) makes every outstanding
 * access token fail this check on its next request — immediate, no ≤15m lag. Legacy tokens (pre-Phase-1,
 * no tver) skip the check and pass through to natural expiry.
 */
@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtConstants.adminSecret,
    });
  }

  async validate(payload: AdminAccessPayload): Promise<AdminPrincipal | null> {
    if (payload.scope !== 'admin') return null; // non-admin token rejected
    const admin = await this.prisma.admin.findUnique({
      where: { id: payload.sub },
      select: { role: true, tokenVersion: true, enabled: true },
    });
    if (!admin || !admin.enabled) return null; // admin gone or disabled → reject
    if (payload.tver !== undefined && payload.tver !== admin.tokenVersion) return null; // session revoked
    return { adminId: payload.sub, role: admin.role };
  }
}
