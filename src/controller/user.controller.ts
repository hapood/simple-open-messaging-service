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
  ThreadIdDto,
  UserByUniqNameDto,
  QueryUsersDto,
  QueryValidThreadDto,
  QueryPendingThreadDto,
  UpdateProfileDto,
  BlockDto,
  ReportDto,
} from '../dto/user.dto.js';
import { UserBlockService } from '../user-block/user-block.service.js';
import { UserReportService } from '../user-report/user-report.service.js';

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
    private readonly userReportService: UserReportService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/my-profile')
  @ApiOperation({ summary: '获取当前用户资料' })
  @ApiResultResponse(UserResponseDto)
  async getMyProfile(@Request() req): Promise<ApiResult> {
    // hasNotiBox=true so the response carries userNotiBox.hasUrFriendReq — the source
    // of truth for the friend-request badge. Without it the badge can never light up,
    // even though the NOTIFY SSE + atomic flag write are wired end-to-end.
    const data = await this.userService.findUniqueUser(
      { id: req.user.userId },
      true,
      true,
    );
    delete data.hashPwd;
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/update-avatar')
  @ApiOperation({
    summary:
      '更新当前用户头像（multipart file；sharp 重写为 32/64/128/256/512 多档 webp）',
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
    // magic number 前置：快速拒绝伪造 mimetype 的非图片（sharp 会在 saveAvatars 里二次校验）。
    if (!this.uploadService.isImage(img.mimetype, img.buffer)) {
      return { code: BusinessCode.VALIDATION_FAILED, message: 'invalid image' };
    }
    // 先读旧头像 → 落盘新多档 → 写库 → 清旧全部尺寸（顺序保证 DB 已更新才删旧文件）。
    const old = await this.userService.findUniqueUser({ id: req.user.userId });
    let url: string;
    try {
      url = await this.uploadService.saveAvatars(img.buffer);
    } catch {
      // sharp decode 失败（损坏/像素炸弹/非图）→ 一律按 invalid image 拒绝，不落盘不写库。
      return { code: BusinessCode.VALIDATION_FAILED, message: 'invalid image' };
    }
    await this.userService.updateAvatar(req.user.userId, url);
    await this.uploadService.deleteByUrl(old?.userExtra?.avatar ?? '');
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
  @ApiOperation({ summary: '更新当前用户昵称/简介（handle 不可改）' })
  @ApiResultResponse(UserResponseDto)
  async updateProfile(
    @Request() req,
    @Body() dto: UpdateProfileDto,
  ): Promise<ApiResult> {
    const data = await this.userService.updateProfile(req.user.userId, dto);
    delete data.hashPwd;
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/query-thread/valid')
  @ApiOperation({ summary: '查询有效会话列表（含对端 user/group 信息）' })
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
      include: { userExtra: true },
    });
    const userDict: Record<number, (typeof peerUsers)[number]> = {};
    peerUsers.forEach((u) => {
      delete u.hashPwd;
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
            include: { userExtra: true },
          })
        : [];
    const senderNameById = new Map<number, string>();
    groupSenders.forEach((u) => {
      // queryUsers is a generic passthrough (Prisma.UserFindManyArgs) so its TS return is the base
      // User; the userExtra include is present at runtime. Cast to read the display name.
      const extra = (u as { userExtra?: { name?: string } | null }).userExtra;
      senderNameById.set(u.id, extra?.name || u.uniqName);
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
  @ApiOperation({ summary: '查询待处理（对方发起的）好友请求' })
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
  @ApiOperation({ summary: '查询我发出的待处理好友请求' })
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
  @ApiOperation({ summary: '发送好友请求' })
  async sendFriendRequest(
    @Request() req,
    @Body() dto: UserIdDto,
  ): Promise<ApiResult> {
    if (req.user.userId === dto.userId) {
      return {
        code: BusinessCode.FRIEND_SELF,
        message: 'can not make friend with self',
      };
    }
    const friend = await this.userService.findUniqueUser(
      { id: dto.userId },
      false,
    );
    if (!friend) {
      return {
        code: BusinessCode.NOT_FOUND,
        message: 'friend does not exist',
        messageKey: 'friend.msg.friendNotFound',
      };
    }
    // makeFriendRequest 状态语义见 friendship.service.ts：
    //  0 首次发请求 / 1 已是好友 / 2 删除后重发 / 3 对端先发过→互加成功 / 5 对端待处理或已拉黑
    const res = await this.friendshipService.makeFriendRequest(
      req.user.userId,
      friend.id,
    );
    // status 0 (first request) and 2 (deleted→reset) both create a fresh pending request
    // for the recipient → push a live NOTIFY so their badge arms instantly (the
    // Notify row + hasUrFriendReq flag were already written atomically in the tx).
    if (res.status === 0 || res.status === 2) {
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
        // 对端已发过（幂等）或已拉黑。后者不回显"被拉黑"以免泄露屏蔽状态。
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
  @ApiOperation({ summary: '同意好友请求' })
  async acceptFriendRequest(
    @Request() req,
    @Body() dto: UserIdDto,
  ): Promise<ApiResult> {
    const res = await this.friendshipService.approveFriendRequest(
      dto.userId,
      req.user.userId,
    );
    if (res.status !== 0) {
      return {
        code: BusinessCode.FRIEND_NO_INCOMING,
        message: `user [${dto.userId}] did not send you a friend request.`,
      };
    }
    // The tx just created a new P2P MessageThread + both ThreadParticipant rows. Notify BOTH
    // participants so each side's conversation list picks up the new thread live: the original
    // requester otherwise has no signal their request was accepted, and the approver's other
    // online tabs/devices wouldn't see it from this HTTP response alone.
    const payload = serializeBody({
      event: 'NOTIFY',
      type: 'FRIEND_APPROVED',
      byUserId: req.user.userId,
    });
    this.sseService.onNotify(dto.userId, payload);
    this.sseService.onNotify(req.user.userId, payload);
    return { code: BusinessCode.OK, message: 'friend request approved' };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/decline-friend-request')
  @ApiOperation({ summary: '拒绝好友请求' })
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
  @ApiOperation({ summary: '撤销我发出的好友请求' })
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
      return {
        code: BusinessCode.FRIEND_SELF,
        message: 'can not unfriend self',
      };
    }
    const res = await this.friendshipService.deleteFriendship(
      req.user.userId,
      dto.userId,
    );
    if (res.status !== 'ok') {
      // No APPROVED relationship to end — idempotent. THREAD_NOT_FOUND matches the P2P "no
      // conversation" signal the rest of the message/thread routes use.
      return {
        code: BusinessCode.THREAD_NOT_FOUND,
        message: `not friends with [${dto.userId}]`,
      };
    }
    // Tell the peer to drop the conversation immediately. Their participant row was soft-left in
    // the same tx, so a refetch hides it too; the NOTIFY just avoids the round-trip latency.
    this.sseService.onNotify(
      dto.userId,
      serializeBody({
        event: 'NOTIFY',
        type: 'FRIEND_DELETED',
        byUserId: req.user.userId,
      }),
    );
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
  @Post('user/report')
  @ApiOperation({
    summary: 'File an abuse/complaint report against a user (admin-console ingestion; no chat effect).',
  })
  async reportUser(@Request() req, @Body() dto: ReportDto): Promise<ApiResult> {
    if (req.user.userId === dto.userId) {
      return { code: BusinessCode.FRIEND_SELF, message: 'can not report self' };
    }
    await this.userReportService.report(req.user.userId, dto.userId, dto.reason);
    return { code: BusinessCode.OK, message: 'report submitted' };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/query')
  @ApiOperation({ summary: '按 userId 批量查用户（≤100）' })
  @ApiResultResponse(UserResponseDto, true)
  async queryUserBase(@Body() dto: QueryUsersDto): Promise<ApiResult> {
    const list = await this.userService.queryUsers({
      where: { id: { in: dto.userIds }, isDeleted: false },
      include: { userExtra: true },
    });
    list.forEach((item) => {
      delete item.hashPwd;
    });
    return { code: BusinessCode.OK, message: 'successful', data: list };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/by-uniq-name')
  @ApiOperation({ summary: '按 uniqName 查用户' })
  @ApiResultResponse(UserResponseDto)
  async getUserByUniqName(@Body() dto: UserByUniqNameDto): Promise<ApiResult> {
    const user = await this.userService.findUniqueUser(
      { uniqName: dto.uniqName, isDeleted: false },
      true,
    );
    if (user !== null) {
      delete user.hashPwd;
      return { code: BusinessCode.OK, message: 'successful', data: user };
    } else {
      return {
        code: BusinessCode.NOT_FOUND,
        message: `can not find user [${dto.uniqName}]`,
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('/user/thread-info')
  @ApiOperation({ summary: '查询会话详情（含对端 user/group）' })
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
          include: { userExtra: true },
        });
        if (peerUser) {
          delete peerUser.hashPwd;
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
          include: { userExtra: true },
        });
        // Same runtime-only userExtra include as the list path (queryUsers is a generic passthrough).
        const extra = (sender as { userExtra?: { name?: string } | null } | undefined)?.userExtra;
        item.lastMessageSenderName = sender ? extra?.name || sender.uniqName : null;
      }
    }
    return { code: BusinessCode.OK, message: 'successful', data: item };
  }

  @ApiTags('auth')
  @HttpCode(HttpStatus.OK)
  @Post('user/register')
  @ApiOperation({ summary: '注册新用户' })
  async registerLocal(@Body() dto: RegisterDto): Promise<ApiResult> {
    /* uniqName/password 的格式校验（regex）已移入 RegisterDto 的 @Matches → 失败走 ValidationPipe → 200/10000。
       业务校验（uniqName 重复）仍在 service，走 200 + ALREADY_EXISTS。 */
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
