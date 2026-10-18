import {
  Controller,
  Post,
  Body,
  Request,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { UserIntentService } from '../user/p2p-intent/authored/user-intent.service.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { businessEnvelope } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { isBusinessRejection } from '../common/business-command-result.js';
import type { UserIntentOutcome } from '../user/p2p-intent/authored/user-intent.service.js';
import {
  AcceptRelationshipDto,
  ReadRelationshipRequestsDto,
  RequestRelationshipDto,
  RevokeRelationshipDto,
} from '../dto/relationship.dto.js';
import { normalizeAccount } from '../common/account.js';
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
    private readonly clientStateFeed: ClientStateFeedService,
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
    return {
      readThroughFeedId:
        await this.clientStateFeed.markRelationshipRequestsRead(
          req.user.userId,
          dto.readThroughFeedId,
        ),
    };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('revoke')
  @ApiOperation({
    summary:
      'Revoke a user relationship/request or a pending federated group-join request by account and identity namespace',
  })
  async revokeRelationship(
    @Request() req: FastifyRequest,
    @Body() dto: RevokeRelationshipDto,
  ) {
    const me = req.user.userId;
    const account = dto.account.trim().toLowerCase();
    const namespaceId = dto.namespaceId;
    if (account.startsWith('!')) {
      const outcome = await this.memberIntents.executeByNamespace({
        memberUserId: me,
        target: { account, namespaceId },
        decision: 'REVOKED',
      });
      if (isBusinessRejection(outcome))
        return businessEnvelope(outcome.code, outcome.message, {
          status: outcome.status,
          reason: outcome.reason,
        });
      return outcome;
    }
    // The composed revocation owns the state gate: withdraw (own pending),
    // reject (incoming pending), and end-friendship all resolve inside one
    // transaction; nothing live on either side is the NOT_FOUND case.
    const outcome = await this.userIntents.execute({
      userId: me,
      decision: 'REVOKED',
      target: {
        account,
        namespaceId,
      },
    });
    if (isBusinessRejection(outcome) && outcome.code === BusinessCode.NOT_FOUND)
      return businessEnvelope(
        BusinessCode.FRIEND_NOT_FOUND,
        `relationship with account [${account}], namespaceId [${namespaceId}] does not exist`,
        { status: outcome.status, reason: outcome.reason },
      );
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
          admissionInTx: (tx) => this.userQuota.tick(me, 'requests', tx),
        }),
      );
    }
    // A known-nsid target: the request follows the row's current domain binding
    // across a review-approved re-bind; only a reset retirement is a mismatch.
    const outcome = await this.userIntents.execute(
      {
        userId: me,
        decision: 'REQUESTED',
        snapshot: dto.snapshot,
        target: {
          account,
          namespaceId,
        },
        note: dto.note ?? '',
      },
      { admissionInTx: (tx) => this.userQuota.tick(me, 'requests', tx) },
    );
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
    summary:
      'Accept a relationship request by account and identity namespace (friend → P2P thread; group → join as MEMBER)',
  })
  async acceptRelationship(
    @Request() req: FastifyRequest,
    @Body() dto: AcceptRelationshipDto,
  ) {
    const me = req.user.userId;
    const account = normalizeAccount(dto.account);
    const namespaceId = dto.namespaceId;
    if (account.startsWith('!')) {
      return this.memberIntentResult(
        await this.memberIntents.executeByNamespace({
          memberUserId: me,
          target: { account, namespaceId },
          decision: 'ACCEPTED',
        }),
      );
    }
    // Identity resolution and the live-request gate belong to the intent
    // transaction, so stale or missing requests return REJECTED instead of
    // escaping through the exception pipeline.
    const outcome = await this.userIntents.execute({
      userId: me,
      decision: 'ACCEPTED',
      target: {
        account,
        namespaceId,
      },
    });
    if (isBusinessRejection(outcome) && outcome.code === BusinessCode.NOT_FOUND)
      return businessEnvelope(BusinessCode.INVITE_NOT_FOUND, outcome.message, {
        status: outcome.status,
        reason: outcome.reason,
      });
    return this.intentResult(outcome);
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
