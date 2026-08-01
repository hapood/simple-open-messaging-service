import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ADMIN_ROLES_KEY } from './admin-roles.decorator.js';
import { AdminRole } from '../database/enums.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import type { AdminPrincipal } from './admin-session.js';

type AdminRequest = FastifyRequest & { user?: AdminPrincipal };

/**
 * Role gate for admin routes decorated with @Roles(...). Reads the caller's role from `req.user.role`
 * (populated by AdminJwtStrategy) and rejects with FORBIDDEN when it is absent or not in the allowed
 * set. Runs strictly AFTER AdminAuthGuard in the guard chain. Routes without @Roles pass through
 * (AdminAuthGuard already proved a valid admin identity) — list/view endpoints are open to all roles.
 */
@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminRole[] | undefined>(
      ADMIN_ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    // No @Roles metadata → this route only needs a valid admin identity (AdminAuthGuard enforced it).
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const role = req.user?.role;
    if (!role || !required.includes(role)) {
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'insufficient admin role for this action',
      );
    }
    return true;
  }
}
