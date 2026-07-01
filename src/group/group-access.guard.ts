import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { GroupService } from './group.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * Membership gate for group routes keyed by `groupId` in the body.
 *
 * Resolves the group (NOT_FOUND when absent) and the caller's ACTIVE ThreadParticipant
 * (GROUP_NOT_MEMBER when they have no live membership), then attaches both to
 * `req.groupAccess` so the controller and RolesGuard read them without re-querying. This is the
 * single authorization check shared by P2P and GROUP conversations lifted into a declarative
 * guard, replacing the inline `findActiveParticipant` checks scattered through Phase 1.
 *
 * Throws BusinessException so the HTTP-200-plus-domain-code envelope is preserved (see
 * AllExceptionsFilter); it does NOT map to a raw 403/404.
 */
@Injectable()
export class GroupAccessGuard implements CanActivate {
  constructor(
    private readonly groupService: GroupService,
    private readonly participantService: ThreadParticipantService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const userId = req.user?.userId;
    const groupId = (req.body as { groupId?: number } | undefined)?.groupId;

    if (userId === undefined || groupId === undefined) {
      // Defensive: every route using this guard takes { groupId } via ValidationPipe. Reaching
      // here means the DTO changed without updating the guard — surface it loudly, not silently.
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'groupId is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const group = await this.groupService.findUniqeGroup({ id: groupId });
    if (group === null) {
      throw new BusinessException(BusinessCode.NOT_FOUND, `no group [${groupId}]`);
    }

    const participant = await this.participantService.findActiveParticipant(
      userId,
      group.threadId,
    );
    if (participant === null) {
      throw new BusinessException(
        BusinessCode.GROUP_NOT_MEMBER,
        `you are not in group [${groupId}]`,
      );
    }

    req.groupAccess = { group, participant };
    return true;
  }
}
