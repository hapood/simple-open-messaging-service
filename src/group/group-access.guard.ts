import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { GroupService } from './group.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { assertPositiveInt } from '../common/assert.js';
import { RESOURCE_ID_KEY } from '../common/resource-id.decorator.js';

/**
 * Membership gate for group routes. The body field carrying `groupId` is declared per route with
 * `@ResourceId<Dto>('groupId')` (read via Reflector), so the guard itself carries no hard-coded field
 * name: a DTO rename is a compile error at the use site, not a silent drift. Mirrors the codebase's
 * existing `RolesGuard` + `@Roles()` authorization convention.
 *
 * Resolves the group and the caller's ACTIVE ThreadParticipant, then attaches both to
 * `req.groupAccess` so the controller and RolesGuard read them without re-querying. This is the
 * single authorization check shared by group routes, lifted into a declarative guard.
 *
 * Both "no such group" and "exists but caller is not an active member" collapse to the SAME
 * NOT_FOUND outcome — deliberately non-leaking (a non-member cannot tell the group exists),
 * mirroring ThreadAccessGuard's policy for thread-keyed routes.
 *
 * Throws BusinessException so the HTTP-200-plus-domain-code envelope is preserved (see
 * AllExceptionsFilter); it does NOT map to a raw 403/404.
 */
@Injectable()
export class GroupAccessGuard implements CanActivate {
  constructor(
    private readonly groupService: GroupService,
    private readonly participantService: ThreadParticipantService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const userId = req.user?.userId;
    const field = this.reflector.get<string>(RESOURCE_ID_KEY, ctx.getHandler());

    // JwtAuthGuard attaches req.user before us; @ResourceId is put on by the route. Either missing is a
    // route wiring bug (not a client error) — surface it loudly instead of silently 500'ing.
    if (userId === undefined || field === undefined) {
      throw new BusinessException(
        BusinessCode.INTERNAL,
        'GroupAccessGuard misconfigured (missing principal or @ResourceId)',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // Strict positive-integer gate (no transform): guards run before ValidationPipe, so the body value
    // is still raw JSON. assertPositiveInt rejects a non-number with VALIDATION_FAILED before it can
    // reach Prisma's Int field (which would surface as an opaque 500). The field name comes from the
    // route's @ResourceId, so the error message names the actual DTO field.
    const groupId = assertPositiveInt(
      (req.body as Record<string, unknown> | undefined)?.[field],
      field,
    );

    const group = await this.groupService.findUniqeGroup({ id: groupId });
    if (group === null) {
      throw new BusinessException(BusinessCode.NOT_FOUND, `no group [${groupId}]`);
    }

    const participant = await this.participantService.findActiveParticipant(
      userId,
      group.threadId,
    );
    if (participant === null) {
      // Deliberately the SAME code+message as the missing-group branch above: a non-member must not
      // be able to tell the group exists by distinguishing "no such group" from "not a member". This
      // mirrors ThreadAccessGuard's non-leak policy for thread-keyed routes.
      throw new BusinessException(BusinessCode.NOT_FOUND, `no group [${groupId}]`);
    }

    req.groupAccess = { group, participant };
    return true;
  }
}
