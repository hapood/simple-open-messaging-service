import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiConsumes,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { UserService } from '../user/user.service.js';
import { UploadService } from '../upload/upload.service.js';
import { MessageService } from '../message/message.service.js';
import { GroupService } from '../group/group.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { FriendshipService } from '../friendship/friendship.service.js';
import {
  FriendshipStatus,
  GroupRole,
  MessageThreadType,
  Prisma,
} from '../prisma/generated/client.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { SseService } from '../gateway/sse.service.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import { ApiResult, ApiResultResponse } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import {
  ConversationItemDto,
  FriendshipDto,
  UserResponseDto,
} from '../dto/response.dto.js';
import { RegisterDto } from '../dto/auth.dto.js';
import {
  UserIdDto,
  SendFriendRequestDto,
  ThreadIdDto,
  UserByUniqNameDto,
  PeerTrustStatusDto,
  QueryUsersDto,
  QueryValidThreadDto,
  QueryPendingThreadDto,
  UpdateProfileDto,
  BlockDto,
} from '../dto/user.dto.js';
import { UserBlockService } from '../user-block/user-block.service.js';
import { FederationService, parseHandle, type S2SProfile } from '../federation/federation.service.js';

@ApiTags('user')
@Controller()
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly friendshipService: FriendshipService,
    private readonly participantService: ThreadParticipantService,
    private readonly authService: AuthService,
    private readonly groupService: GroupService,
    private readonly uploadService: UploadService,
    private readonly sseService: SseService,
    private readonly messageService: MessageService,
    private readonly userBlockService: UserBlockService,
    private readonly federationService: FederationService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/my-profile')
  @ApiOperation({ summary: 'Get the current user profile' })
  @ApiResultResponse(UserResponseDto)
  async getMyProfile(@Request() req): Promise<ApiResult> {
    // findSelfProfile keeps the self-only hasUrFriendReq badge (the source of truth for the
    // friend-request badge) and omits hashPwd. Every other user read uses findUniqueUser/queryUsers,
    // which omit BOTH — so the badge only ever appears here, never on another user's data.
    const data = await this.userService.findSelfProfile(req.user.userId);
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/update-avatar')
  @ApiOperation({
    summary:
      'Update the current user avatar (multipart file; sharp rewrites to 32/64/128/256/512 multi-size webp)',
  })
  @ApiConsumes('multipart/form-data')
  async updateAvatar(@Request() req: FastifyRequest): Promise<ApiResult> {
    const img = await this.uploadService.consumeImage(req);
    if (img.kind === 'rejected') {
      return {
        code: BusinessCode.VALIDATION_FAILED,
        message:
          img.reason === 'no-file'
            ? 'no file'
            : img.reason === 'too-large'
              ? 'file too large'
              : 'invalid image',
      };
    }
    // Magic-number check first: quickly reject non-images with a forged mimetype (sharp re-validates in saveAvatars).
    if (!this.uploadService.isImage(img.mimetype, img.buffer)) {
      return { code: BusinessCode.VALIDATION_FAILED, message: 'invalid image' };
    }
    // Read old avatar → write new multi-size → update DB → delete old sizes (order guarantees the DB is updated before old files are deleted).
    const old = await this.userService.findUniqueUser({ id: req.user.userId });
    let url: string;
    try {
      url = await this.uploadService.saveAvatars(img.buffer);
    } catch {
      // sharp decode failure (corrupt / pixel-bomb / non-image) → always rejected as invalid image; nothing written to disk or DB.
      return { code: BusinessCode.VALIDATION_FAILED, message: 'invalid image' };
    }
    await this.userService.updateAvatar(req.user.userId, url);
    await this.uploadService.deleteByUrl(old?.avatar ?? '');
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: { avatar: url },
    };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/update-profile')
  @ApiOperation({ summary: 'Update the current user display name / bio (handle is immutable)' })
  @ApiResultResponse(UserResponseDto)
  async updateProfile(
    @Request() req,
    @Body() dto: UpdateProfileDto,
  ): Promise<ApiResult> {
    const data = await this.userService.updateProfile(req.user.userId, dto);
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/query-thread/valid')
  @ApiOperation({ summary: 'List active conversations (includes peer user/group info)' })
  @ApiResultResponse(ConversationItemDto, true)
  async queryValidThread(
    @Request() req,
    @Body() dto: QueryValidThreadDto,
  ): Promise<ApiResult> {
    const me = req.user.userId;
    const where: Prisma.ThreadParticipantWhereInput = {
      userId: me,
      leftAt: null,
    };
    if (dto.type) {
      where.thread = { is: { type: dto.type } };
    }
    const list = await this.participantService.queryParticipants({
      where,
      skip: dto.skip,
      take: dto.take,
      orderBy: { id: 'asc' },
      include: { thread: true },
    });
    // Unread counts for every thread in one batched query (uses the Message(threadId,id) index).
    const unread = await this.messageService.countUnreadByThread(
      me,
      list.map((p) => p.threadId),
    );
    // Pinned tier first (pinned = true), within it most-recently-pinned first (pinnedAt desc); then the
    // unpinned tier recent-first by lastMessageAt; empty threads sink. In-memory sort of ≤take rows is
    // trivial; threadId breaks ties deterministically. (Pinned/pinnedAt are on the participant row.)
    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned) {
        const ta = a.pinnedAt?.getTime() ?? -Infinity;
        const tb = b.pinnedAt?.getTime() ?? -Infinity;
        return tb - ta || a.threadId - b.threadId;
      }
      const la = a.thread.lastMessageAt?.getTime() ?? -Infinity;
      const lb = b.thread.lastMessageAt?.getTime() ?? -Infinity;
      return lb - la || a.threadId - b.threadId;
    });
    // Hydrate P2P peers: the other active participant on each P2P thread.
    const p2pThreadIds = list
      .filter((p) => p.thread.type === 'P2P')
      .map((p) => p.threadId);
    const peers = await this.participantService.findP2PPeers(p2pThreadIds, me);
    const peerByThread = new Map(peers.map((p) => [p.threadId, p.userId]));
    const peerUsers = await this.userService.queryUsers({
      where: {
        id: { in: peers.map((p) => p.userId) },
        isDeleted: false,
      },
    });
    const userDict: Record<number, (typeof peerUsers)[number]> = {};
    peerUsers.forEach((u) => {
      userDict[u.id] = u;
    });
    // Hydrate each P2P peer's blocked-by-caller flag in one batched UserBlock lookup, so the chat
    // header menu shows Block ↔ Unblock and the banner reflects state on first load.
    const blockedPeers = await this.userBlockService.blockedAmong(
      me,
      peers.map((p) => p.userId),
    );
    // Hydrate GROUP conversations by their threadId.
    const groupThreadIds = list
      .filter((p) => p.thread.type === 'GROUP')
      .map((p) => p.threadId);
    const groups =
      groupThreadIds.length > 0
        ? await this.groupService.queryGroups({
            where: { threadId: { in: groupThreadIds } },
          })
        : [];
    const groupByThread = new Map(groups.map((g) => [g.threadId, g]));
    // Hydrate the last-message sender's display name for GROUP threads so the list can prefix group
    // previews with "Name:". Only GROUP senders are resolved — P2P previews are never prefixed (the
    // peer is implied), so the dict simply has no entry for P2P senders.
    const groupSenderIds = Array.from(
      new Set(
        list
          .filter((p) => p.thread.type === 'GROUP')
          .map((p) => p.thread.lastMessageSenderId)
          .filter((id): id is number => id != null),
      ),
    );
    const groupSenders =
      groupSenderIds.length > 0
        ? await this.userService.queryUsers({
            where: { id: { in: groupSenderIds } },
          })
        : [];
    const senderNameById = new Map<number, string>();
    groupSenders.forEach((u) => {
      senderNameById.set(u.id, u.name || u.uniqName);
    });
    const data = list.map((p) => {
      const item = {
        id: p.id,
        threadId: p.threadId,
        type: p.thread.type,
        lastReadMsgId: p.lastReadMsgId ?? undefined,
        role: p.role ?? undefined,
        unreadCount: unread.get(p.threadId) ?? 0,
        lastMessagePreview: p.thread.lastMessagePreview ?? null,
        lastMessageAt: p.thread.lastMessageAt ?? null,
        lastMessageSenderId: p.thread.lastMessageSenderId ?? null,
        lastMessageSenderName:
          p.thread.lastMessageSenderId != null
            ? (senderNameById.get(p.thread.lastMessageSenderId) ?? null)
            : null,
        // Per-user display state: mute (notification suppression), pin (top-tier ordering), and the
        // per-user clear-history watermark (query-messages hides rows older than this for this user).
        muted: p.muted,
        pinned: p.pinned,
        pinnedAt: p.pinnedAt ?? null,
        clearedAt: p.clearedAt ?? null,
        alias: p.alias ?? null,
      } as {
        id: number;
        threadId: number;
        type: MessageThreadType;
        lastReadMsgId: bigint | undefined;
        role: GroupRole | undefined;
        unreadCount: number;
        lastMessagePreview: string | null;
        lastMessageAt: Date | null;
        lastMessageSenderId: number | null;
        lastMessageSenderName: string | null;
        muted: boolean;
        pinned: boolean;
        pinnedAt: Date | null;
        clearedAt: Date | null;
        blocked?: boolean;
        alias: string | null;
        peerUser?: unknown;
        group?: unknown;
      };
      if (p.thread.type === 'P2P') {
        const peerId = peerByThread.get(p.threadId);
        if (peerId !== undefined) {
          item.peerUser = userDict[peerId];
          item.blocked = blockedPeers.has(peerId);
        }
      } else {
        item.group = groupByThread.get(p.threadId);
      }
      return item;
    });
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/query-thread/to-pending')
  @ApiOperation({ summary: 'List pending (incoming) friend requests' })
  @ApiResultResponse(FriendshipDto, true)
  async queryPendingThread(
    @Request() req,
    @Body() dto: QueryPendingThreadDto,
  ): Promise<ApiResult> {
    const me = req.user.userId;
    const list = await this.friendshipService.queryFriendships({
      take: dto.take,
      skip: dto.skip,
      where: {
        status: FriendshipStatus.PENDING,
        requesterId: { not: me },
        OR: [{ userAId: me }, { userBId: me }],
        updatedAt: { lt: new Date(dto.beforeDate) },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: list.map((f) => this.withPeerUser(f, me)),
    };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/query-thread/from-pending')
  @ApiOperation({ summary: 'List my outgoing pending friend requests' })
  @ApiResultResponse(FriendshipDto, true)
  async queryFromPendingThread(
    @Request() req,
    @Body() dto: QueryPendingThreadDto,
  ): Promise<ApiResult> {
    const me = req.user.userId;
    const list = await this.friendshipService.queryFriendships({
      take: dto.take,
      skip: dto.skip,
      where: {
        status: FriendshipStatus.PENDING,
        requesterId: me,
        updatedAt: { lt: new Date(dto.beforeDate) },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: list.map((f) => this.withPeerUser(f, me)),
    };
  }

  /** Attach the other user's id to a friendship row so the client can resolve the peer profile. */
  private withPeerUser<T extends { userAId: number; userBId: number }>(
    f: T,
    me: number,
  ): T & { peerUserId: number } {
    return { ...f, peerUserId: f.userAId === me ? f.userBId : f.userAId };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/send-friend-request')
  @ApiOperation({ summary: 'Send a friend request (optional ≤255 note; federated recipients go via S2S automatically)' })
  async sendFriendRequest(
    @Request() req,
    @Body() dto: SendFriendRequestDto,
  ): Promise<ApiResult> {
    if (req.user.userId === dto.userId) {
      return {
        code: BusinessCode.FRIEND_SELF,
        message: 'can not make friend with self',
      };
    }
    const friend = await this.userService.findUniqueUser({ id: dto.userId });
    if (!friend) {
      return {
        code: BusinessCode.NOT_FOUND,
        message: 'friend does not exist',
        messageKey: 'friend.msg.friendNotFound',
      };
    }
    // makeFriendRequest status: 0 first / 1 already friends / 2 deleted→reset / 3 mutual→auto-approve / 5 pending|blocked
    const res = await this.friendshipService.makeFriendRequest(
      req.user.userId,
      friend.id,
      dto.message ?? '',
    );
    const message = dto.message ?? '';
    if (friend.isForeigner) {
      // Federated recipient → synchronous S2S send (no local SSE; the peer surfaces it to its user).
      // Idempotent on the receiver, so the user can retry safely if the peer was momentarily down.
      if (res.status === 0 || res.status === 2 || res.status === 3) {
        try {
          // Resolve-on-demand: if the foreign stub was addressed by id without a prior resolve (so it's
          // a bare localpart with no avatar/name), pull + localize the profile first. No-op when the
          // resolve endpoint already localized it. The send would fail against the same peer anyway.
          await this.federationService.ensureForeignUserLocalized(friend.id, {
            localpart: friend.uniqName,
            domain: friend.domain,
          });
          await this.federationService.sendFriendRequest(
            req.user.userId,
            { localpart: friend.uniqName, domain: friend.domain },
            message,
          );
        } catch (e) {
          return {
            code: BusinessCode.FEDERATION_DELIVERY_FAILED,
            message: `could not reach ${friend.domain}: ${(e as Error).message}`,
          };
        }
      }
    } else if (res.status === 0 || res.status === 2) {
      // Local recipient → live NOTIFY so their badge arms instantly (the Notify row + hasUrFriendReq
      // flag were already written atomically in the tx).
      this.sseService.onNotify(
        friend.id,
        serializeBody({
          event: 'NOTIFY',
          type: 'FRIEND_REQUEST',
          fromUserId: req.user.userId,
        }),
      );
    }
    switch (res.status) {
      case 0:
      case 2:
        return { code: BusinessCode.OK, message: 'friend request sent', messageKey: 'friend.msg.sent' };
      case 1:
        return { code: BusinessCode.OK, message: 'you are already friends', messageKey: 'friend.msg.alreadyFriends' };
      case 3:
        return { code: BusinessCode.OK, message: 'you are now friends', messageKey: 'friend.msg.nowFriends' };
      case 5:
        // Peer already sent (idempotent) or blocked. The latter is not echoed to avoid leaking the block.
        return { code: BusinessCode.OK, message: 'friend request sent', messageKey: 'friend.msg.sent' };
      default:
        return {
          code: BusinessCode.FRIEND_UNKNOWN_STATE,
          message: 'unknown error',
        };
    }
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/approve-friend-request')
  @ApiOperation({ summary: 'Accept a friend request' })
  async acceptFriendRequest(
    @Request() req,
    @Body() dto: UserIdDto,
  ): Promise<ApiResult> {
    const requester = await this.userService.findUniqueUser({ id: dto.userId });
    if (!requester) {
      return { code: BusinessCode.NOT_FOUND, message: `user [${dto.userId}] not found` };
    }
    const res = await this.friendshipService.approveFriendRequest(dto.userId, req.user.userId);
    if (res.status !== 0) {
      return {
        code: BusinessCode.FRIEND_NO_INCOMING,
        message: `user [${dto.userId}] did not send you a friend request.`,
      };
    }
    const payload = serializeBody({
      event: 'NOTIFY',
      type: 'FRIEND_APPROVED',
      byUserId: req.user.userId,
    });
    if (requester.isForeigner) {
      // Federated requester → synchronous S2S friend.approve (the peer creates its own thread +
      // surfaces to the requester). No local SSE to the foreign stub; only the local approver's
      // other tabs/devices get the live NOTIFY.
      try {
        await this.federationService.sendFriendApprove(req.user.userId, {
          localpart: requester.uniqName,
          domain: requester.domain,
        });
      } catch (e) {
        return {
          code: BusinessCode.FEDERATION_DELIVERY_FAILED,
          message: `could not reach ${requester.domain}: ${(e as Error).message}`,
        };
      }
      this.sseService.onNotify(req.user.userId, payload);
    } else {
      // Local requester → NOTIFY both sides so each picks up the new thread live.
      this.sseService.onNotify(dto.userId, payload);
      this.sseService.onNotify(req.user.userId, payload);
    }
    return { code: BusinessCode.OK, message: 'friend request approved' };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/decline-friend-request')
  @ApiOperation({ summary: 'Decline a friend request' })
  async declineFriendRequest(
    @Request() req,
    @Body() dto: UserIdDto,
  ): Promise<ApiResult> {
    const res = await this.friendshipService.declineFriendRequest(
      dto.userId,
      req.user.userId,
    );
    if (res.status === 0) {
      return { code: BusinessCode.OK, message: 'friend request declined' };
    } else {
      return {
        code: BusinessCode.FRIEND_NO_INCOMING,
        message: `user [${dto.userId}] did not send you a friend request.`,
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/cancel-friend-request')
  @ApiOperation({ summary: 'Cancel my outgoing friend request' })
  async cancelFriendRequest(
    @Request() req,
    @Body() dto: UserIdDto,
  ): Promise<ApiResult> {
    const res = await this.friendshipService.cancelFriendRequest(
      req.user.userId,
      dto.userId,
    );
    if (res.status === 0) {
      return { code: BusinessCode.OK, message: 'friend request cancelled' };
    } else {
      return {
        code: BusinessCode.FRIEND_NO_INCOMING,
        message: `user [${dto.userId}] has no pending request from you.`,
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/delete-friend')
  @ApiOperation({ summary: 'Unfriend — end a P2P conversation (mutual)' })
  async deleteFriend(
    @Request() req,
    @Body() dto: UserIdDto,
  ): Promise<ApiResult> {
    if (req.user.userId === dto.userId) {
      return { code: BusinessCode.FRIEND_SELF, message: 'can not unfriend self' };
    }
    const peer = await this.userService.findUniqueUser({ id: dto.userId });
    const res = await this.friendshipService.deleteFriendship(req.user.userId, dto.userId);
    if (res.status !== 'ok') {
      // No APPROVED relationship to end — idempotent. THREAD_NOT_FOUND matches the P2P "no
      // conversation" signal the rest of the message/thread routes use.
      return { code: BusinessCode.THREAD_NOT_FOUND, message: `not friends with [${dto.userId}]` };
    }
    if (!peer?.isForeigner) {
      // Local peer → NOTIFY so their conversation list drops it immediately. Their participant row
      // was soft-left in the tx; the NOTIFY just avoids the round-trip latency.
      this.sseService.onNotify(
        dto.userId,
        serializeBody({
          event: 'NOTIFY',
          type: 'FRIEND_DELETED',
          byUserId: req.user.userId,
        }),
      );
    }
    // Federated peer → LOCAL-ONLY deletion. No S2S notification is sent: unfriending never fans out.
    // The peer discovers the severed edge lazily, via a rejection-on-send in Step 2 (the next time the
    // peer tries to message, our inbox rejects it as "not friends"). See docs/federation-protocol.md.
    return { code: BusinessCode.OK, message: 'friend removed' };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/block')
  @ApiOperation({
    summary:
      'Block / unblock a user (P2P). Independent of friendship; the message path drops delivery + hides their messages.',
  })
  async setBlock(@Request() req, @Body() dto: BlockDto): Promise<ApiResult> {
    if (req.user.userId === dto.userId) {
      return { code: BusinessCode.FRIEND_SELF, message: 'can not block self' };
    }
    if (dto.block) {
      await this.userBlockService.block(req.user.userId, dto.userId);
    } else {
      await this.userBlockService.unblock(req.user.userId, dto.userId);
    }
    // No peer SSE: a block never reveals itself to the blocked user. The blocker's own other devices
    // will refetch the thread view to show the blocked banner; no live frame is needed for correctness.
    return {
      code: BusinessCode.OK,
      message: dto.block ? 'user blocked' : 'user unblocked',
    };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/query')
  @ApiOperation({ summary: 'Look up users by userId in batch (≤100)' })
  @ApiResultResponse(UserResponseDto, true)
  async queryUserBase(@Body() dto: QueryUsersDto): Promise<ApiResult> {
    const list = await this.userService.queryUsers({
      where: { id: { in: dto.userIds }, isDeleted: false },
    });
    return { code: BusinessCode.OK, message: 'successful', data: list };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/peer-trust-status')
  @ApiOperation({
    summary:
      'Pre-flight: is mutual trust with a peer domain already established? Drives the first-contact "connecting…" affordance on a federated handle search.',
  })
  async peerTrustStatus(@Body() dto: PeerTrustStatusDto): Promise<ApiResult> {
    // Pure local allow-list lookup (no network) — tells the client whether the upcoming federated
    // resolve will run the init handshake (untrusted → first contact → banner) or resolve fast
    // (trusted → no banner). A known server-side fact, not a latency guess: the rare
    // already-trusted-but-failing case (peer reset / broken key → re-handshake) surfaces as an error
    // from the resolve itself, not here.
    const trusted = await this.federationService.isPeerTrusted(dto.domain);
    return { code: BusinessCode.OK, message: 'successful', data: { trusted } };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/by-uniq-name')
  @ApiOperation({ summary: 'Look up a user by uniqName or localpart@domain handle (federated resolves via S2S)' })
  @ApiResultResponse(UserResponseDto)
  async getUserByUniqName(@Body() dto: UserByUniqNameDto): Promise<ApiResult> {
    // The query can be a plain localpart ("alice") or a full handle ("bob@bbb.com").
    const h = parseHandle(dto.uniqName);
    // Federated handle (@localpart@<peer-domain>) → establish mutual trust (init handshake, if not
    // already trusted), fetch the peer's profile (avatar inline as base64), find-or-create a stub, and
    // localize it (persist the avatar via saveAvatars + write name/bio), so the caller can address the
    // user by id in subsequent friend ops (same as a local lookup).
    if (h && h.domain !== this.federationService.ourDomain) {
      try {
        // Trust prerequisite: the signed profile GET below is allow-list-gated on the peer, and our
        // guard gates their reply traffic — so mutual trust must exist first. Idempotent (no-op if
        // already trusted). The peer auto-accepts us via the init handshake.
        await this.federationService.ensurePeerTrusted(h.domain);
      } catch (e) {
        return {
          code: BusinessCode.FEDERATION_DELIVERY_FAILED,
          message: `could not establish trust with ${h.domain}: ${(e as Error).message}`,
        };
      }
      let profile: S2SProfile;
      try {
        profile = await this.federationService.fetchRemoteUser(h);
      } catch (e) {
        return {
          code: BusinessCode.FEDERATION_DELIVERY_FAILED,
          message: `could not reach ${h.domain}: ${(e as Error).message}`,
        };
      }
      const foreignId = await this.federationService.ensureForeignUser(h.localpart, h.domain);
      await this.federationService.localizeForeignProfile(foreignId, profile);
      // Return the localized stub (avatar is now a /uploads/* URL, not the wire base64).
      const data = await this.userService.findUniqueUser({ id: foreignId });
      return { code: BusinessCode.OK, message: 'successful', data };
    }
    // Local: plain localpart, or a handle whose domain is ours → look up by localpart.
    const localpart = h ? h.localpart : dto.uniqName;
    const user = await this.userService.findUniqueUser({
      uniqName_domain: { uniqName: localpart, domain: 'local' },
      isDeleted: false,
    });
    if (user !== null) {
      return { code: BusinessCode.OK, message: 'successful', data: user };
    }
    return {
      code: BusinessCode.NOT_FOUND,
      message: `can not find user [${dto.uniqName}]`,
    };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/sync-peer-profile')
  @ApiOperation({
    summary:
      'Refresh a federated peer profile if stale (chat-open hook). Probes the peer /revision and re-pulls avatar/name/bio only when newer; local users are a no-op.',
  })
  @ApiResultResponse(UserResponseDto)
  async syncPeerProfile(@Body() dto: UserIdDto): Promise<ApiResult> {
    // Chat-open staleness hook: probe the peer's /revision; if newer than the stub's remoteUpdatedAt,
    // re-pull + re-localize the avatar/name/bio. Best-effort — a transient peer outage keeps the cached
    // profile so opening the conversation never blocks. Local users are always fresh locally (no probe).
    await this.federationService.syncForeignUserIfStale(dto.userId);
    const data = await this.userService.findUniqueUser({ id: dto.userId });
    if (!data) {
      return { code: BusinessCode.NOT_FOUND, message: `user [${dto.userId}] not found` };
    }
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('/user/thread-info')
  @ApiOperation({ summary: 'Get conversation details (includes peer user/group)' })
  @ApiResultResponse(ConversationItemDto)
  async queryUserThreadInfo(
    @Request() req,
    @Body() dto: ThreadIdDto,
  ): Promise<ApiResult> {
    const me = req.user.userId;
    const [p] = await this.participantService.queryParticipants({
      where: { userId: me, threadId: dto.threadId, leftAt: null },
      include: { thread: true },
      take: 1,
    });
    if (!p) {
      // Non-membership / no-such-thread collapse to THREAD_NOT_FOUND — the same code the message
      // routes return via ThreadAccessGuard, so a client gets one consistent "no conversation"
      // signal across thread-info / send / query / mark-read.
      return {
        code: BusinessCode.THREAD_NOT_FOUND,
        message: `no thread [${dto.threadId}]`,
      };
    }
    const unread = await this.messageService.countUnreadByThread(me, [
      p.threadId,
    ]);
    const item = {
      id: p.id,
      threadId: p.threadId,
      type: p.thread.type,
      lastReadMsgId: p.lastReadMsgId ?? undefined,
      role: p.role ?? undefined,
      unreadCount: unread.get(p.threadId) ?? 0,
      lastMessagePreview: p.thread.lastMessagePreview ?? null,
      lastMessageAt: p.thread.lastMessageAt ?? null,
      lastMessageSenderId: p.thread.lastMessageSenderId ?? null,
      muted: p.muted,
      pinned: p.pinned,
      pinnedAt: p.pinnedAt ?? null,
      clearedAt: p.clearedAt ?? null,
      alias: p.alias ?? null,
    } as {
      id: number;
      threadId: number;
      type: MessageThreadType;
      lastReadMsgId: bigint | undefined;
      role: GroupRole | undefined;
      unreadCount: number;
      lastMessagePreview: string | null;
      lastMessageAt: Date | null;
      lastMessageSenderId: number | null;
      lastMessageSenderName?: string | null;
      muted: boolean;
      pinned: boolean;
      pinnedAt: Date | null;
      clearedAt: Date | null;
      blocked?: boolean;
      alias: string | null;
      peerUser?: unknown;
      group?: unknown;
    };
    if (p.thread.type === 'P2P') {
      const peers = await this.participantService.findP2PPeers(
        [p.threadId],
        me,
      );
      const peerId = peers[0]?.userId;
      if (peerId !== undefined) {
        const [peerUser] = await this.userService.queryUsers({
          where: { id: peerId },
        });
        if (peerUser) {
          item.peerUser = peerUser;
        }
        item.blocked = await this.userBlockService.isBlocked(me, peerId);
      }
    } else {
      const [group] = await this.groupService.queryGroups({
        where: { threadId: p.threadId },
      });
      item.group = group;
      // Resolve the last-message sender's display name for the group preview prefix.
      if (p.thread.lastMessageSenderId != null) {
        const [sender] = await this.userService.queryUsers({
          where: { id: p.thread.lastMessageSenderId },
        });
        item.lastMessageSenderName = sender ? sender.name || sender.uniqName : null;
      }
    }
    return { code: BusinessCode.OK, message: 'successful', data: item };
  }

  @ApiTags('auth')
  @HttpCode(HttpStatus.OK)
  @Post('user/register')
  @ApiOperation({ summary: 'Register a new user' })
  async registerLocal(@Body() dto: RegisterDto): Promise<ApiResult> {
    /* Format validation (regex) for uniqName/password has moved into RegisterDto's @Matches → failures
       go through ValidationPipe → 200/10000. Business validation (uniqName duplicate) stays in the
       service → 200 + ALREADY_EXISTS. */
    const res = await this.userService.addUser({
      uniqName: dto.uniqName,
      hashPwd: await this.authService.hashStr(dto.password),
    });
    if (res.status === 2) {
      return {
        code: BusinessCode.ALREADY_EXISTS,
        message: `User ${dto.uniqName} already exists`,
      };
    } else {
      return {
        code: BusinessCode.OK,
        message: 'successfuly registered',
        data: res.data,
      };
    }
  }
}
