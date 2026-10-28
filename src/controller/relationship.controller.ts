import {
  Controller,
  Post,
  Body,
  Request,
  HttpStatus,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { RelationshipRequestService } from '../relationship/request/relationship-request.service.js';
import { decideMemberGroupRound } from './member-group-round-decision.js';
import {
  QueryRelationshipRequestsDto,
  RequestDecisionDto,
} from '../dto/relationship-request.dto.js';
import { UserIntentService } from '../user/p2p-intent/authored/user-intent.service.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { businessEnvelope } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { isBusinessRejection } from '../common/business-command-result.js';
import type { UserIntentOutcome } from '../user/p2p-intent/authored/user-intent.service.js';
import { ThreadAccessGuard } from '../account-thread-state/thread-access.guard.js';
import { ThrottleGuard, Throttle } from '../rate-limit/throttle.guard.js';
import { ResourceId } from '../common/resource-id.decorator.js';
import {
  AcceptRelationshipDto,
  RevokeRelationshipDto,
  ReadRelationshipRequestsDto,
  RequestRelationshipDto,
} from '../dto/relationship.dto.js';
import {
  MemberAuthoredGroupMembershipIntentService,
  type MemberAuthoredGroupMembershipIntentResult,
} from '../group/membership-intent/authored/member-authored-group-membership-intent.service.js';

/**
 * Relationship endpoints for user and group membership intents. Every P2P
 * command runs synchronously through its authored business intent family.
 */
@ApiTags('relationship')
@Controller('relationship')
export class RelationshipController {
  constructor(
    private readonly requests: RelationshipRequestService,
    private readonly userIntents: UserIntentService,
    private readonly userQuota: UserQuotaService,
    private readonly memberIntents: MemberAuthoredGroupMembershipIntentService,
  ) {}

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('requests/read')
  @ApiOperation({
    summary: 'Advance the account-wide relationship-request read watermark',
  })
  async markRelationshipRequestsRead(
    @Request() req: FastifyRequest,
    @Body() dto: ReadRelationshipRequestsDto,
  ) {
    return this.requests.markRead(req.user.userId, dto.requestReadId);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('requests')
  async queryRequests(
    @Request() req: FastifyRequest,
    @Body() dto: QueryRelationshipRequestsDto,
  ) {
    return this.requests.queryPersonal(req.user.userId, dto);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('requests/reject')
  async rejectRequest(
    @Request() req: FastifyRequest,
    @Body() dto: RequestDecisionDto,
  ) {
    return this.personalDecisionViaIntent(
      req.user.userId,
      dto.requestId,
      'REJECT',
    );
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('requests/withdraw')
  async withdrawRequest(
    @Request() req: FastifyRequest,
    @Body() dto: RequestDecisionDto,
  ) {
    return this.personalDecisionViaIntent(
      req.user.userId,
      dto.requestId,
      'WITHDRAW',
    );
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @Throttle('relationship.revoke')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<RevokeRelationshipDto>('threadId')
  @Post('revoke')
  @ApiOperation({
    summary:
      'End an established P2P relationship by its thread (group-leave symmetric)',
  })
  async revokeRelationship(
    @Request() req: FastifyRequest,
    @Body() _dto: RevokeRelationshipDto,
  ) {
    void _dto;
    // Only an established pair is terminable here; pending request rounds are
    // decided solely by their exact requestId on the request routes.
    const outcome = await this.userIntents.endEstablishedRelationship({
      userId: req.user.userId,
      threadId: req.threadAccess!.threadId,
    });
    if (isBusinessRejection(outcome) && outcome.code === BusinessCode.NOT_FOUND)
      return businessEnvelope(BusinessCode.FRIEND_NOT_FOUND, outcome.message, {
        status: outcome.status,
        reason: outcome.reason,
      });
    return this.intentResult(outcome);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('request')
  @ApiOperation({
    summary: 'Request a user or group relationship by Address',
  })
  async requestRelationship(
    @Request() req: FastifyRequest,
    @Body() dto: RequestRelationshipDto,
  ) {
    const me = req.user.userId;
    const account = dto.account.trim().toLowerCase();
    const namespaceId = dto.namespaceId;
    if (account.startsWith('!')) {
      return this.memberIntentResult(
        await this.memberIntents.executeByNamespace({
          memberUserId: me,
          target: { account, namespaceId },
          decision: 'REQUESTED',
          snapshot: dto.snapshot,
          note: dto.note ?? '',
        }),
      );
    }
    // A known-nsid target: the request follows the row's current domain binding
    // across a review-approved re-bind; only a reset retirement is a mismatch.
    const outcome = await this.userIntents.execute({
      userId: me,
      decision: 'REQUESTED',
      snapshot: dto.snapshot,
      target: {
        account,
        namespaceId,
      },
      note: dto.note ?? '',
    });
    return this.intentResult(outcome);
  }

  /** Synchronous intent result: `threadId` is present only when the pair is
   * active after the command (clients read it as the FRIEND fact). */
  private intentResult(outcome: UserIntentOutcome) {
    if (isBusinessRejection(outcome))
      return businessEnvelope(outcome.code, outcome.message, {
        status: outcome.status,
        reason: outcome.reason,
      });
    return 'threadId' in outcome && outcome.threadId
      ? { status: 'OK' as const, threadId: outcome.threadId }
      : { status: 'OK' as const };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('accept')
  @ApiOperation({
    summary: 'Accept the exact current request round',
  })
  async acceptRelationship(
    @Request() req: FastifyRequest,
    @Body() dto: AcceptRelationshipDto,
  ) {
    return this.personalDecisionViaIntent(
      req.user.userId,
      dto.requestId,
      'ACCEPT',
    );
  }

  /** The domain command validates the exact round under the pair lock. */
  private async personalDecisionViaIntent(
    userId: number,
    requestId: string,
    decision: 'ACCEPT' | 'REJECT' | 'WITHDRAW',
  ) {
    // The personal routes decide any round the caller's SENT/RECEIVED pages
    // surface: FRIEND rounds settle through the P2P intent command, group
    // rounds through the member-authored membership state machine.
    const kind = await this.requests.roundKind(requestId);
    if (kind === null) return { status: 'STALE_REQUEST' };
    if (kind !== 'FRIEND')
      return decideMemberGroupRound(
        { requests: this.requests, memberIntents: this.memberIntents },
        userId,
        requestId,
        decision,
      );
    return this.userIntents.decidePersonalRequest(userId, requestId, decision);
  }

  private memberIntentResult(
    outcome: MemberAuthoredGroupMembershipIntentResult,
  ) {
    if (isBusinessRejection(outcome))
      return businessEnvelope(outcome.code, outcome.message, {
        status: outcome.status,
        reason: outcome.reason,
      });
    return outcome;
  }
}
