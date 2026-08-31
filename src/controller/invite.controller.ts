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
import { ApiResultResponse } from '../common/api-result.js';
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
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { DomainCommandQueueService } from '../domain-command/domain-command-queue.service.js';
import { DomainCommandType } from '../domain-command/domain-command.constants.js';
import { DomainCommandAcceptedDto } from '../dto/domain-command.dto.js';

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
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly domainCommands: DomainCommandQueueService,
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
  @ApiResultResponse(DomainCommandAcceptedDto)
  async sendFriendInvite(
    @Request() req: FastifyRequest,
    @Body() dto: SendFriendInviteDto,
  ): Promise<DomainCommandAcceptedDto> {
    const me = req.user.userId;
    const account = dto.account.trim().toLowerCase();
    const [actor, target] = await Promise.all([
      this.userService.findUniqueUser({ id: me }),
      this.userService.findUniqueUser({
        account_domain: { account, domain: 'local' },
      }),
    ]);
    if (!actor || actor.availability !== 'AVAILABLE') {
      throw new BusinessException(
        BusinessCode.UNAUTHENTICATED,
        'authenticated user does not exist',
      );
    }
    if (target && me === target.id) {
      throw new BusinessException(
        BusinessCode.FRIEND_SELF,
        'can not invite yourself',
      );
    }
    if (!target || target.availability !== 'AVAILABLE') {
      // Errors are localized client-side by their numeric code (see ApiResult.messageKey) — they carry no
      // messageKey — so this throws and flows through the global AllExceptionsFilter like every other error.
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'user does not exist',
      );
    }
    const { commandId } = await this.domainCommands.enqueue({
      aggregate: {
        type: 'USER_PAIR',
        endpoints: [
          { account: actor.account, domain: actor.domain },
          { account: target.account, domain: target.domain },
        ],
      },
      commandType: DomainCommandType.SEND_LOCAL_FRIEND_INVITE,
      actorUserId: me,
      payload: {
        targetUserId: target.id,
        note: dto.note ?? '',
      },
    });
    return { commandId: commandId.toString(), status: 'PENDING' };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/federated-friend')
  @ApiOperation({
    summary: 'Send a federated friend request by Address',
  })
  @ApiResultResponse(DomainCommandAcceptedDto)
  async sendFederatedFriendInvite(
    @Request() req: FastifyRequest,
    @Body() dto: SendFederatedFriendInviteDto,
  ): Promise<DomainCommandAcceptedDto> {
    const actorUserId = req.user.userId;
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
    const actor = await this.userService.findUniqueUser({ id: actorUserId });
    if (!actor || actor.availability !== 'AVAILABLE') {
      throw new BusinessException(
        BusinessCode.UNAUTHENTICATED,
        'authenticated user does not exist',
      );
    }
    const { commandId } = await this.domainCommands.enqueue({
      aggregate: {
        type: 'USER_PAIR',
        endpoints: [
          { account: actor.account, domain: actor.domain },
          { account, domain },
        ],
      },
      commandType: DomainCommandType.SEND_FEDERATED_FRIEND_INVITE,
      actorUserId,
      payload: {
        account,
        domain,
        note: dto.note ?? '',
        displayName: dto.displayName,
        ...(dto.avatar ? { avatar: dto.avatar } : {}),
      },
    });
    return { commandId: commandId.toString(), status: 'PENDING' };
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
    const me = req.user.userId;
    if (this.isAddressedAction(dto)) {
      if (dto.account!.startsWith('!')) {
        const scope =
          await this.inviteService.resolveFederatedFriendRequestCommandScope(
            me,
            dto.account!,
            dto.domain!,
            'INCOMING',
          );
        const { commandId } = await this.domainCommands.enqueue({
          aggregate: { type: 'GROUP', address: scope.remote },
          commandType: DomainCommandType.ACCEPT_ADDRESSED_GROUP_INVITATION,
          actorUserId: me,
          payload: scope.remote,
        });
        return { commandId: commandId.toString(), status: 'PENDING' as const };
      }
      const scope =
        await this.inviteService.resolveFederatedFriendRequestCommandScope(
          me,
          dto.account!,
          dto.domain!,
          'INCOMING',
        );
      const { commandId } = await this.domainCommands.enqueue({
        aggregate: {
          type: 'USER_PAIR',
          endpoints: [scope.local, scope.remote],
        },
        commandType: DomainCommandType.ACCEPT_ADDRESSED_FRIEND_REQUEST,
        actorUserId: me,
        payload: scope.remote,
      });
      return { commandId: commandId.toString(), status: 'PENDING' as const };
    }
    const scope = await this.inviteService.resolveAcceptInviteCommandScope(
      dto.inviteId!,
      me,
    );
    if (scope.kind === 'FRIEND') {
      const { commandId } = await this.domainCommands.enqueue({
        aggregate: { type: 'USER_PAIR', endpoints: scope.endpoints },
        commandType: DomainCommandType.ACCEPT_FRIEND_INVITE,
        actorUserId: me,
        payload: { inviteId: scope.inviteId },
      });
      return { commandId: commandId.toString(), status: 'PENDING' as const };
    }
    const { commandId } = await this.domainCommands.enqueue({
      aggregate: { type: 'GROUP', address: scope.address },
      commandType: DomainCommandType.ACCEPT_GROUP_INVITATION,
      actorUserId: me,
      payload: { threadId: scope.threadId },
    });
    return { commandId: commandId.toString(), status: 'PENDING' as const };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/revoke')
  @ApiOperation({ summary: 'Revoke my own outgoing invite' })
  @ApiResultResponse(DomainCommandAcceptedDto)
  async revokeInvite(
    @Request() req: FastifyRequest,
    @Body() dto: FriendInviteActionDto,
  ): Promise<void | DomainCommandAcceptedDto> {
    const me = req.user.userId;
    if (this.isAddressedAction(dto)) {
      if (dto.account!.startsWith('!')) {
        const address =
          await this.federationService.resolveGroupJoinRequestCommandScope(
            me,
            { account: dto.account!, domain: dto.domain! },
          );
        const { commandId } = await this.domainCommands.enqueue({
          aggregate: { type: 'GROUP', address },
          commandType: DomainCommandType.REVOKE_FEDERATED_GROUP_JOIN,
          actorUserId: me,
          payload: address,
        });
        return { commandId: commandId.toString(), status: 'PENDING' };
      }
      const scope =
        await this.inviteService.resolveFederatedFriendRequestCommandScope(
          me,
          dto.account!,
          dto.domain!,
          'OUTGOING',
        );
      const { commandId } = await this.domainCommands.enqueue({
        aggregate: {
          type: 'USER_PAIR',
          endpoints: [scope.local, scope.remote],
        },
        commandType: DomainCommandType.REVOKE_ADDRESSED_FRIEND_REQUEST,
        actorUserId: me,
        payload: scope.remote,
      });
      return { commandId: commandId.toString(), status: 'PENDING' };
    }
    const scope = await this.inviteService.resolveP2PInviteCommandScope(
      dto.inviteId!,
      me,
      'AUTHOR',
    );
    const { commandId } = await this.domainCommands.enqueue({
      aggregate: { type: 'USER_PAIR', endpoints: scope.endpoints },
      commandType: DomainCommandType.REVOKE_FRIEND_INVITE,
      actorUserId: me,
      payload: { inviteId: scope.inviteId },
    });
    return { commandId: commandId.toString(), status: 'PENDING' };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/reject')
  @ApiOperation({ summary: 'Reject an incoming friend invite' })
  @ApiResultResponse(DomainCommandAcceptedDto)
  async rejectInvite(
    @Request() req: FastifyRequest,
    @Body() dto: InviteIdDto,
  ): Promise<DomainCommandAcceptedDto> {
    const me = req.user.userId;
    const scope = await this.inviteService.resolveP2PInviteCommandScope(
      dto.inviteId,
      me,
      'SUBJECT',
    );
    const { commandId } = await this.domainCommands.enqueue({
      aggregate: { type: 'USER_PAIR', endpoints: scope.endpoints },
      commandType: DomainCommandType.REJECT_FRIEND_INVITE,
      actorUserId: me,
      payload: { inviteId: scope.inviteId },
    });
    return { commandId: commandId.toString(), status: 'PENDING' };
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
