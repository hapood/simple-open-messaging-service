import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ROLES_KEY } from './roles.decorator.js';
import { GroupRole } from '../database/enums.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * Role gate for group routes decorated with @Roles(...). Reads the caller's role from
 * `req.threadAccess.participant` (populated by ThreadAccessGuard — GroupAccessGuard is folded into
 * it now that groups are `!`-User threads) and rejects with GROUP_FORBIDDEN when it is absent or
 * not in the allowed set. Runs strictly AFTER ThreadAccessGuard in the guard chain.
 *
 * Must be combined as: `@UseGuards(ThreadAccessGuard, RolesGuard)` + `@Roles(...)` (JWT auth is global).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<GroupRole[] | undefined>(
      ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    // No @Roles metadata → this route only needs membership (ThreadAccessGuard already enforced it).
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (!req.threadAccess?.membershipActive) {
      throw new BusinessException(BusinessCode.GROUP_FORBIDDEN, 'not a member');
    }
    if (req.threadAccess?.groupDissolved) {
      throw new BusinessException(
        BusinessCode.GROUP_DISSOLVED,
        'group has been dissolved',
      );
    }
    const role = req.threadAccess?.participant?.role;
    if (role === undefined || role === null || !required.includes(role)) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'insufficient role for this action',
      );
    }
    return true;
  }
}
