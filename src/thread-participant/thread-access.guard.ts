import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ThreadParticipantService } from './thread-participant.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { assertPositiveInt } from '../common/assert.js';
import { RESOURCE_ID_KEY } from '../common/resource-id.decorator.js';

/**
 * Membership gate for thread-keyed routes (P2P and GROUP alike). The body field carrying the id is
 * declared per route with `@ResourceId<Dto>('threadId')` (read via Reflector), so the guard itself
 * carries no hard-coded field name: a DTO rename is a compile error at the use site, not a silent
 * drift. This mirrors the codebase's existing `RolesGuard` + `@Roles()` authorization convention.
 *
 * Resolves a history-readable ThreadParticipant. GROUP requires live membership; P2P retains read access
 * after unfriend and exposes `friendshipActive=false` so write handlers can reject it.
 *
 * Both "thread does not exist" and "exists but caller is not an active member" collapse to the same
 * THREAD_NOT_FOUND outcome — deliberately non-leaking (a non-member cannot tell the thread exists).
 *
 * Throws BusinessException so the HTTP-200-plus-domain-code envelope is preserved (see
 * AllExceptionsFilter); it does NOT map to a raw 403/404.
 */
@Injectable()
export class ThreadAccessGuard implements CanActivate {
  constructor(
    private readonly participantService: ThreadParticipantService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const userId = req.user?.userId;
    const field = this.reflector.get<string>(RESOURCE_ID_KEY, ctx.getHandler());

    // SessionAuthGuard attaches req.user before us; @ResourceId is put on by the route. Either missing is a
    // route wiring bug (not a client error) — surface it loudly instead of silently 500'ing.
    if (userId === undefined || field === undefined) {
      throw new BusinessException(
        BusinessCode.INTERNAL,
        'ThreadAccessGuard misconfigured (missing principal or @ResourceId)',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // Strict positive-integer gate (no transform): guards run before ValidationPipe, so the body value
    // is still raw JSON. assertPositiveInt rejects a non-number with VALIDATION_FAILED before it can
    // reach Prisma's Int field (which would surface as an opaque 500). The field name comes from the
    // route's @ResourceId, so the error message names the actual DTO field.
    const threadId = assertPositiveInt(
      (req.body as Record<string, unknown> | undefined)?.[field],
      field,
    );

    const participant =
      await this.participantService.findActiveParticipantWithThread(
        userId,
        threadId,
      );
    if (participant === null) {
      throw new BusinessException(
        BusinessCode.THREAD_NOT_FOUND,
        `no thread [${threadId}]`,
      );
    }

    req.threadAccess = {
      threadId,
      threadType: participant.thread.type,
      participant,
      friendshipActive: participant.leftAt === null,
      membershipActive: participant.leftAt === null,
      groupDissolved: participant.thread.groupUser?.group?.dissolvedAt != null,
    };
    return true;
  }
}
