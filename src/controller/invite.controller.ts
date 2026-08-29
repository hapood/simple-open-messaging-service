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
import { UserService } from '../user/user.service.js';
import { InviteService } from '../invite/invite.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { FederationService } from '../federation/federation.service.js';
import { FederationRelationshipCommandService } from '../federation/federation-relationship-command.service.js';
import { ApiResultResponse, envelope } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  SendFriendInviteDto,
  SendFederatedFriendInviteDto,
  InviteIdDto,
  FriendInviteActionDto,
  InviteDto,
  ReadIncomingInvitesDto,
} from '../dto/invite.dto.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { eq } from 'drizzle-orm';
import * as tables from '../database/schema.js';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../client-state-feed/client-state-feed.service.js';

/**
 * Invite endpoints — the single API for friend-add (and, when wired, group-invite). The service owns
 * invite DB state + unified client-state revisions; this controller orchestrates S2S delivery
 * (federated targets) and live signals after commit.
 *
 * The friend-pending lists are parameterless (backend hardcodes FRIEND / PENDING / last-7-days / ≤200)
 * and additionally filter out any invite whose peer is already a friend, so a stale row never offers
 * an "accept?" for an existing friend.
 */
@ApiTags('invite')
@Controller()
export class InviteController {
  constructor(
    private readonly userService: UserService,
    private readonly inviteService: InviteService,
    private readonly participantService: ThreadParticipantService,
    private readonly federationService: FederationService,
    private readonly relationshipCommands: FederationRelationshipCommandService,
    private readonly userQuota: UserQuotaService,
    private readonly clientStateFeed: ClientStateFeedService,
  ) {}

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/incoming/read')
  @ApiOperation({
    summary: 'Advance the account-wide incoming-invitation read watermark',
  })
  async markIncomingInvitesRead(
    @Request() req: FastifyRequest,
    @Body() dto: ReadIncomingInvitesDto,
  ) {
    return {
      readThroughFeedId: await this.clientStateFeed.markIncomingInvitesRead(
        req.user.userId,
        dto.readThroughFeedId,
      ),
    };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/friend')
  @ApiOperation({
    summary: 'Send a friend invite to a local account',
  })
  async sendFriendInvite(
    @Request() req: FastifyRequest,
    @Body() dto: SendFriendInviteDto,
  ) {
    const me = req.user.userId;
    const account = dto.account.trim().toLowerCase();
    const target = await this.userService.findUniqueUser({
      account_domain: { account, domain: 'local' },
    });
    if (target && me === target.id) {
      throw new BusinessException(
        BusinessCode.FRIEND_SELF,
        'can not invite yourself',
      );
    }
    if (!target) {
      // Errors are localized client-side by their numeric code (see ApiResult.messageKey) — they carry no
      // messageKey — so this throws and flows through the global AllExceptionsFilter like every other error.
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'user does not exist',
      );
    }
    if (await this.participantService.areFriends(me, target.id)) {
      return envelope(undefined, {
        message: 'you are already friends',
        messageKey: 'friend.msg.alreadyFriends',
      });
    }

    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const res = await this.inviteService.createFriendInvite(
      me,
      target.id,
      dto.note ?? '',
      true,
      undefined,
      async (tx, created) => {
        if (created) await this.userQuota.tick(me, 'requests', tx);
        clientFeedUpdates.push(
          ...(await this.inviteService.writeLocalFriendIntentInTx(
            tx,
            me,
            target.id,
            true,
            dto.note ?? '',
          )),
        );
      },
    );
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);

    if (res.status === 'auto-accepted') {
      // Local mutual → friends immediately. Both sides' thread-list adds are driven by the
      // Client-state feed updates notify both local devices after commit.
      // no dedicated friend event — the delta subsumes it, aligning local
      // with the federated path which already dropped it).
      return envelope(
        { threadId: res.threadId } as { threadId: number | undefined },
        {
          message: 'you are now friends',
          messageKey: 'friend.msg.nowFriends',
        },
      );
    }

    // Local recipients learn through the client state feed; federation uses its own durable feed.
    return envelope(
      { inviteId: res.inviteId },
      {
        message: 'friend request sent',
        messageKey: 'friend.msg.sent',
      },
    );
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/federated-friend')
  @ApiOperation({
    summary: 'Send a federated friend request by Address',
  })
  async sendFederatedFriendInvite(
    @Request() req: FastifyRequest,
    @Body() dto: SendFederatedFriendInviteDto,
  ) {
    const account = dto.account.trim().toLowerCase();
    const domain = dto.domain.trim().toLowerCase();
    if (domain === 'local' || domain === this.federationService.ourDomain)
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'local friend requests use /invite/friend',
      );
    await this.federationService.ensurePeerTrusted(domain);
    if (account.startsWith('!'))
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'group requests use /group/federated-join-request',
      );
    let statePeers = new Map<string, bigint>();
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const result = await this.inviteService.createFederatedFriendInvite(
      req.user.userId,
      account,
      domain,
      dto.note ?? '',
      { displayName: dto.displayName, avatar: dto.avatar },
      async (tx, state) => {
        await this.userQuota.tick(req.user.userId, 'requests', tx);
        statePeers =
          await this.relationshipCommands.writeAddressedFriendRequestInTx(
            tx,
            req.user.userId,
            { account, domain, namespaceId: state.namespaceId },
            state,
            clientFeedUpdates,
          );
      },
    );
    await this.federationService.pushStateFeedDomains(statePeers.keys());
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    return envelope(
      { account, domain },
      {
        message: 'friend request sent',
        messageKey: result.created
          ? 'friend.msg.sent'
          : 'friend.msg.requestAlreadySent',
      },
    );
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/accept')
  @ApiOperation({
    summary:
      'Accept an invite by id (friend → P2P thread; group → join as MEMBER)',
  })
  async acceptInvite(
    @Request() req: FastifyRequest,
    @Body() dto: FriendInviteActionDto,
  ) {
    if (this.isAddressedAction(dto)) {
      const peers = await this.federationService.acceptAddressedFriendRequest(
        req.user.userId,
        { account: dto.account!, domain: dto.domain! },
      );
      await this.federationService.pushStateFeedDomains(peers.keys());
      return {};
    }
    // acceptInvite throws BusinessException (INVITE_EXPIRED / NOT_FOUND / …) → the global filter renders it.
    let friendStatePeers = new Map<string, bigint>();
    let groupStatePeers = new Map<string, bigint>();
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const res = await this.inviteService.acceptInvite(
      dto.inviteId!,
      req.user.userId,
      async (tx, fromUserId) => {
        const from = await tx.query.user.findFirst({
          where: eq(tables.user.id, fromUserId),
          columns: { domain: true },
        });
        if (from?.domain !== 'local') {
          friendStatePeers =
            await this.relationshipCommands.writeFriendIntentInTx(
              tx,
              req.user.userId,
              fromUserId,
              true,
              '',
              clientFeedUpdates,
              true,
            );
        } else
          clientFeedUpdates.push(
            ...(await this.inviteService.writeLocalFriendIntentInTx(
              tx,
              req.user.userId,
              fromUserId,
              true,
            )),
          );
      },
      async (tx, threadId) => {
        groupStatePeers =
          await this.relationshipCommands.writeMemberRelationshipIntentInTx(
            tx,
            threadId,
            req.user.userId,
            'ACCEPTED',
            clientFeedUpdates,
          );
        await this.inviteService.writeGroupRequestClientStateInTx(
          tx,
          threadId,
          req.user.userId,
          clientFeedUpdates,
        );
      },
    );
    await this.federationService.pushStateFeedDomains(friendStatePeers.keys());
    await this.federationService.pushStateFeedDomains(groupStatePeers.keys());
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);

    if (res.kind === 'FRIEND') {
      const fromUser = await this.userService.findUniqueUser({
        id: res.fromUserId,
      });
      void fromUser;
      // Both local devices receive a state-feed update; no dedicated friend event (the feed
      // subsumes it, aligning local with the federated path which already dropped it). Accepting does not
      // create another unread incoming request, so no extra revision is needed.
      return { threadId: res.threadId };
    }

    // Federated join delivery is the RELATIONSHIP_INTENT written in the accept transaction above.
    return { threadId: res.threadId };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/revoke')
  @ApiOperation({ summary: 'Revoke my own outgoing invite' })
  async revokeInvite(
    @Request() req: FastifyRequest,
    @Body() dto: FriendInviteActionDto,
  ): Promise<void> {
    const me = req.user.userId;
    if (this.isAddressedAction(dto)) {
      if (dto.account!.startsWith('!')) {
        await this.federationService.revokeGroupJoinRequest(me, {
          account: dto.account!,
          domain: dto.domain!,
        });
        return;
      }
      const peers = await this.federationService.revokeAddressedOutgoingRequest(
        me,
        { account: dto.account!, domain: dto.domain! },
      );
      await this.federationService.pushStateFeedDomains(peers.keys());
      return;
    }
    let statePeers = new Map<string, bigint>();
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    await this.inviteService.revokeInvite(
      dto.inviteId!,
      me,
      async (tx, toUserId) => {
        const to = await tx.query.user.findFirst({
          where: eq(tables.user.id, toUserId),
          columns: { domain: true },
        });
        if (to?.domain !== 'local')
          statePeers = await this.relationshipCommands.writeFriendIntentInTx(
            tx,
            me,
            toUserId,
            false,
            '',
            clientFeedUpdates,
          );
        else
          clientFeedUpdates.push(
            ...(await this.inviteService.writeLocalFriendIntentInTx(
              tx,
              me,
              toUserId,
              false,
            )),
          );
      },
    );
    await this.federationService.pushStateFeedDomains(statePeers.keys());
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/reject')
  @ApiOperation({ summary: 'Reject an incoming friend invite' })
  async rejectInvite(
    @Request() req: FastifyRequest,
    @Body() dto: InviteIdDto,
  ): Promise<void> {
    const me = req.user.userId;
    let statePeers = new Map<string, bigint>();
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    await this.inviteService.rejectInvite(
      dto.inviteId,
      me,
      async (tx, fromUserId) => {
        const from = await tx.query.user.findFirst({
          where: eq(tables.user.id, fromUserId),
          columns: { domain: true },
        });
        if (from?.domain !== 'local')
          statePeers = await this.relationshipCommands.writeFriendIntentInTx(
            tx,
            me,
            fromUserId,
            false,
            '',
            clientFeedUpdates,
          );
        else
          clientFeedUpdates.push(
            ...(await this.inviteService.writeLocalFriendIntentInTx(
              tx,
              me,
              fromUserId,
              false,
            )),
          );
      },
    );
    await this.federationService.pushStateFeedDomains(statePeers.keys());
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
  }

  private isAddressedAction(dto: FriendInviteActionDto): boolean {
    const hasAddress = dto.account !== undefined || dto.domain !== undefined;
    if (
      hasAddress &&
      (!dto.account || !dto.domain || dto.inviteId !== undefined)
    )
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'provide exactly inviteId or account + domain',
      );
    return hasAddress;
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/incoming')
  @ApiOperation({
    summary:
      'List incoming pending friend invites (last 7 days, ≤200, friends filtered out)',
  })
  @ApiResultResponse(InviteDto, true)
  async listIncoming(@Request() req: FastifyRequest) {
    const me = req.user.userId;
    const [rows, friendIds] = await Promise.all([
      this.inviteService.listIncoming(me),
      this.participantService.getActiveP2PPeerUserIds(me),
    ]);
    const friends = new Set(friendIds);
    // Hide invites from users who are already friends (stale / re-armed edge cases).
    return rows.filter((r) => !friends.has(r.fromUserId));
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/outgoing')
  @ApiOperation({
    summary:
      'List my outgoing pending friend invites (last 7 days, ≤200, friends filtered out)',
  })
  @ApiResultResponse(InviteDto, true)
  async listOutgoing(@Request() req: FastifyRequest) {
    const me = req.user.userId;
    const [rows, friendIds] = await Promise.all([
      this.inviteService.listOutgoing(me),
      this.participantService.getActiveP2PPeerUserIds(me),
    ]);
    const friends = new Set(friendIds);
    return rows.filter((r) => !friends.has(r.toUserId));
  }
}
