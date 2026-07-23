import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { UserService } from '../user/user.service.js';
import { InviteService } from '../invite/invite.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { SseService } from '../gateway/sse.service.js';
import { FederationService } from '../federation/federation.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import { ApiResult, ApiResultResponse } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { GroupRole } from '../prisma/generated/client.js';
import {
  SendFriendInviteDto,
  InviteIdDto,
  InviteDto,
  InviteDetailDto,
} from '../dto/invite.dto.js';

/**
 * Invite endpoints — the single API for friend-add (and, when wired, group-invite). The service owns
 * invite DB state + the derived `friendReqRev` (MAX(updatedAt) over incoming FRIEND invites); this
 * controller orchestrates S2S delivery (federated targets) and the live NOTIFY + FRIEND_REQ_REV_UPDATED
 * frames, mirroring how UserController orchestrated the old friend flow.
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
    private readonly sseService: SseService,
    private readonly federationService: FederationService,
    private readonly quota: QuotaService,
  ) {}

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/friend')
  @ApiOperation({ summary: 'Send a friend invite (federated targets delivered via S2S automatically)' })
  async sendFriendInvite(
    @Request() req: FastifyRequest,
    @Body() dto: SendFriendInviteDto,
  ): Promise<ApiResult> {
    const me = req.user.userId;
    if (me === dto.toUserId) {
      return { code: BusinessCode.FRIEND_SELF, message: 'can not invite yourself' };
    }
    const target = await this.userService.findUniqueUser({ id: dto.toUserId });
    if (!target) {
      return {
        code: BusinessCode.NOT_FOUND,
        message: 'user does not exist',
        messageKey: 'friend.msg.friendNotFound',
      };
    }
    if (target.isGroup) {
      return {
        code: BusinessCode.FRIEND_INVALID_TARGET,
        message: 'cannot add a group as a friend',
      };
    }
    if (await this.participantService.areFriends(me, target.id)) {
      return {
        code: BusinessCode.OK,
        message: 'you are already friends',
        messageKey: 'friend.msg.alreadyFriends',
      };
    }

    // Daily quota (local aggregate): a friend request consumes one 'requests' unit (anti-spam). Ticked
    // AFTER validation so a request to a non-existent / already-friend target never burns the budget.
    const q = await this.quota.tryTickLocal('requests');
    if (q.exceeded) {
      return {
        code: BusinessCode.QUOTA_EXCEEDED,
        message: `daily friend-request quota reached (${q.limit}); resets in ${q.retryAfter}s`,
        data: { category: 'requests', limit: q.limit, retryAfter: q.retryAfter },
      };
    }

    // Mutual auto-accept is LOCAL-only (a federated target needs an S2S round-trip on accept).
    const res = await this.inviteService.createFriendInvite(
      me,
      target.id,
      dto.note ?? '',
      !target.isForeigner,
    );

    if (res.status === 'auto-accepted') {
      // Local mutual → friends immediately. Both sides' thread-list adds are driven by the
      // THREAD_REVISION_UPDATED delta (recordThreadAdd fires for both users in createFriendInvite);
      // no NOTIFY — the former FRIEND_APPROVED push is dropped (the delta subsumes it, aligning local
      // with the federated path which already dropped it).
      return {
        code: BusinessCode.OK,
        message: 'you are now friends',
        messageKey: 'friend.msg.nowFriends',
        data: { threadId: res.threadId },
      };
    }

    // created | already-pending → deliver to the target.
    if (target.isForeigner) {
      // Federated target → synchronous S2S friend-request (the peer creates the incoming invite +
      // arms its user's badge). Idempotent on the receiver (overwrite on P2002), so retries are safe.
      try {
        await this.federationService.sendInvite({
          kind: 'FRIEND',
          fromLocalUserId: me,
          to: { account: target.account, domain: target.domain },
          note: dto.note ?? '',
        });
      } catch (e) {
        return {
          code: BusinessCode.FEDERATION_DELIVERY_FAILED,
          message: `could not reach ${target.domain}: ${(e as Error).message}`,
        };
      }
    } else {
      // Local target → live NOTIFY (the notification popup + fromUserId/inviteId) AND the friendReqRev
      // push (the mergeable badge signal). friendReqRev = MAX(updatedAt) over the target's incoming FRIEND
      // invites, just advanced by the PENDING invite createFriendInvite wrote; the client compares it to
      // its IDB cursor to arm the badge, and the native layer merges it into its cached HELLO.
      this.sseService.onNotify(
        target.id,
        serializeBody({
          event: 'NOTIFY',
          type: 'FRIEND_REQUEST',
          fromUserId: me,
          inviteId: res.inviteId,
        }),
      );
      void this.inviteService.findLatestFriendReqUpdate(target.id).then((friendReqRev) =>
        this.sseService.onFriendReqRevUpdated(target.id, { friendReqRev }),
      );
    }
    return {
      code: BusinessCode.OK,
      message: 'friend request sent',
      messageKey: 'friend.msg.sent',
      data: { inviteId: res.inviteId },
    };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/accept')
  @ApiOperation({ summary: 'Accept an invite by id (friend → P2P thread; group → join as MEMBER)' })
  async acceptInvite(
    @Request() req: FastifyRequest,
    @Body() dto: InviteIdDto,
  ): Promise<ApiResult> {
    let res;
    try {
      res = await this.inviteService.acceptInvite(dto.inviteId, req.user.userId);
    } catch (e) {
      if (e instanceof BusinessException) {
        return { code: e.bizCode, message: e.message };
      }
      throw e;
    }

    if (res.kind === 'FRIEND') {
      const fromUser = await this.userService.findUniqueUser({ id: res.fromUserId });
      if (fromUser?.isForeigner) {
        // Federated inviter → S2S friend-approve so the peer creates its own thread + marks its
        // outgoing invite ACCEPTED. Both sides' thread-list adds are driven by THREAD_REVISION_UPDATED
        // (recordThreadAdd fires for the approver here, and for the inviter via the S2S accept path).
        try {
          await this.federationService.sendInviteAccept({
            kind: 'FRIEND',
            fromLocalUserId: req.user.userId,
            targetDomain: fromUser.domain,
            by: { account: fromUser.account, domain: fromUser.domain },
          });
        } catch (e) {
          return {
            code: BusinessCode.FEDERATION_DELIVERY_FAILED,
            message: `could not reach ${fromUser.domain}: ${(e as Error).message}`,
          };
        }
      }
      // Local inviter: recordThreadAdd fired for both users in acceptInvite's tx → both sides get
      // THREAD_REVISION_UPDATED; no NOTIFY (the former FRIEND_APPROVED push is dropped — the delta
      // subsumes it, aligning local with the federated path which already dropped it).
      // The accepted FRIEND invite was incoming to the accepter → its status flip advanced friendReqRev
      // (MAX updatedAt over their incoming FRIEND invites). Push so the badge re-derives + the native
      // HELLO cache stays fresh for a webview reclaim.
      void this.inviteService.findLatestFriendReqUpdate(req.user.userId).then((friendReqRev) =>
        this.sseService.onFriendReqRevUpdated(req.user.userId, { friendReqRev }),
      );
      return {
        code: BusinessCode.OK,
        message: 'friend request approved',
        data: { threadId: res.threadId },
      };
    }

    // GROUP → fan out GROUP_ROSTER_UPDATED (signal-only) to the active local roster (incl. the new
    // member). The client pulls the fresh roster. The former GROUP_MEMBER_JOINED payload (userId/role)
    // is dropped — toast/UX detail is handled client-side from the pulled roster.
    const members = await this.participantService.getActiveParticipantUserIds(res.threadId);
    const audience = new Set([...members.map((m) => m.userId), req.user.userId]);
    audience.forEach((uid) => this.sseService.onGroupEvent(uid, 'GROUP_ROSTER_UPDATED', { threadId: res.threadId }));

    // Federated mirror (a cross-server group): tell the ORIGIN this user joined, so the origin adds them
    // to the canonical roster + fans out a thread/member join to every member-server (roster consistency).
    // A local group (no fedGroupAccount) needs no propagation.
    const fed = res.fedGroupAccount;
    const origin = res.originDomain;
    if (fed && origin && origin !== this.federationService.ourDomain) {
      try {
        await this.federationService.sendInviteAccept({
          kind: 'GROUP',
          fromLocalUserId: req.user.userId,
          targetDomain: origin,
          group: fed,
        });
      } catch (e) {
        return {
          code: BusinessCode.FEDERATION_DELIVERY_FAILED,
          message: `could not reach ${origin}: ${(e as Error).message}`,
        };
      }
    }
    return { code: BusinessCode.OK, message: 'joined', data: { threadId: res.threadId } };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/reject')
  @ApiOperation({ summary: 'Reject an incoming invite' })
  async rejectInvite(@Request() req: FastifyRequest, @Body() dto: InviteIdDto): Promise<ApiResult> {
    try {
      await this.inviteService.rejectInvite(dto.inviteId, req.user.userId);
    } catch (e) {
      if (e instanceof BusinessException) return { code: e.bizCode, message: e.message };
      throw e;
    }
    // The rejected invite was incoming to the rejecter → friendReqRev advanced. Push so the badge
    // re-derives + the native HELLO cache stays fresh.
    void this.inviteService.findLatestFriendReqUpdate(req.user.userId).then((friendReqRev) =>
      this.sseService.onFriendReqRevUpdated(req.user.userId, { friendReqRev }),
    );
    return { code: BusinessCode.OK, message: 'invite rejected' };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/revoke')
  @ApiOperation({ summary: 'Revoke my own outgoing invite' })
  async revokeInvite(@Request() req: FastifyRequest, @Body() dto: InviteIdDto): Promise<ApiResult> {
    try {
      await this.inviteService.revokeInvite(dto.inviteId, req.user.userId);
    } catch (e) {
      if (e instanceof BusinessException) return { code: e.bizCode, message: e.message };
      throw e;
    }
    return { code: BusinessCode.OK, message: 'invite revoked' };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/incoming')
  @ApiOperation({ summary: 'List incoming pending friend invites (last 7 days, ≤200, friends filtered out)' })
  @ApiResultResponse(InviteDto, true)
  async listIncoming(@Request() req: FastifyRequest): Promise<ApiResult> {
    const me = req.user.userId;
    const [rows, friendIds] = await Promise.all([
      this.inviteService.listIncoming(me),
      this.participantService.getActiveP2PPeerUserIds(me),
    ]);
    const friends = new Set(friendIds);
    // Hide invites from users who are already friends (stale / re-armed edge cases).
    const data = rows.filter((r) => !friends.has(r.fromUserId));
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/outgoing')
  @ApiOperation({ summary: 'List my outgoing pending friend invites (last 7 days, ≤200, friends filtered out)' })
  @ApiResultResponse(InviteDto, true)
  async listOutgoing(@Request() req: FastifyRequest): Promise<ApiResult> {
    const me = req.user.userId;
    const [rows, friendIds] = await Promise.all([
      this.inviteService.listOutgoing(me),
      this.participantService.getActiveP2PPeerUserIds(me),
    ]);
    const friends = new Set(friendIds);
    const data = rows.filter((r) => !friends.has(r.toUserId));
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/detail')
  @ApiOperation({ summary: 'Live invite state for the group-invite dialog (validity / already-joined)' })
  @ApiResultResponse(InviteDetailDto)
  async getInviteDetail(@Request() req: FastifyRequest, @Body() dto: InviteIdDto): Promise<ApiResult> {
    try {
      const data = await this.inviteService.getInviteDetail(dto.inviteId, req.user.userId);
      return { code: BusinessCode.OK, message: 'successful', data };
    } catch (e) {
      if (e instanceof BusinessException) return { code: e.bizCode, message: e.message };
      throw e;
    }
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('invite/mark-read')
  @ApiOperation({ summary: 'Clear the friend-request unread badge' })
  async markRead(@Request() req: FastifyRequest): Promise<ApiResult> {
    await this.inviteService.markRead(req.user.userId);
    return { code: BusinessCode.OK, message: 'successful' };
  }
}
