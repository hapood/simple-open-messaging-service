import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ThreadParticipantService } from './thread-participant.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * Membership gate for thread-keyed routes (P2P and GROUP alike) carrying a `threadId` in the body.
 *
 * The declarative counterpart of `GroupAccessGuard`: resolves the caller's ACTIVE ThreadParticipant
 * and rejects with THREAD_NOT_FOUND when they have no live membership, then attaches both to
 * `req.threadAccess` so the controller reads them without re-querying. This is the single
 * authorization check shared by every message-route handler (send / query / mark-read), lifted out
 * of the inline `findActiveParticipant` blocks that used to open each handler.
 *
 * Both "thread does not exist" and "exists but caller is not an active member" collapse to the same
 * THREAD_NOT_FOUND outcome — deliberately non-leaking (a non-member cannot tell the thread exists),
 * matching the policy the inline checks already enforced.
 *
 * Throws BusinessException so the HTTP-200-plus-domain-code envelope is preserved (see
 * AllExceptionsFilter); it does NOT map to a raw 403/404.
 */
@Injectable()
export class ThreadAccessGuard implements CanActivate {
  constructor(
    private readonly participantService: ThreadParticipantService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const userId = req.user?.userId;
    const threadId = (req.body as { threadId?: number } | undefined)?.threadId;

    if (userId === undefined || threadId === undefined) {
      // Defensive: every route using this guard takes { threadId } via ValidationPipe. Reaching
      // here means the DTO changed without updating the guard — surface it loudly, not silently.
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'threadId is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const participant = await this.participantService.findActiveParticipant(
      userId,
      threadId,
    );
    if (participant === null) {
      throw new BusinessException(
        BusinessCode.THREAD_NOT_FOUND,
        `no thread [${threadId}]`,
      );
    }

    req.threadAccess = { threadId, participant };
    return true;
  }
}
