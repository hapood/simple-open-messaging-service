import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Res,
  Request,
  UseGuards,
  HttpStatus,
  HttpCode,
  forwardRef,
  Inject,
  Optional,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiConsumes,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { FastifyReply } from 'fastify';
import { UserService } from '../user/user.service.js';
import { UploadService } from '../upload/upload.service.js';
import { MessageService } from '../message/message.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { SystemMessageType } from '../message/system-message.js';
import { GroupService } from '../group/group.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { GroupRole, MessageThreadType } from '../database/enums.js';
import { messageThread, threadParticipant } from '../database/schema.js';
import { AuthService } from '../auth/auth.service.js';
import { SseService } from '../gateway/sse.service.js';
import { ThreadRevisionService } from '../thread-revision/thread-revision.service.js';
import { planThreadDelta } from '../thread-revision/thread-delta.js';
import { Public } from '../common/public.decorator.js';
import { ApiResultResponse, envelope } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { PUBLIC_CONFIG } from '../config/public-config.js';
import { normalizeAccount } from '../common/account.js';
import { ConversationItemDto, UserResponseDto } from '../dto/response.dto.js';
import { RegisterDto } from '../dto/auth.dto.js';
import {
  UserIdDto,
  DeleteFriendDto,
  ThreadIdDto,
  UserResolveDto,
  UserSearchDto,
  PeerTrustStatusDto,
  QueryUsersDto,
  ThreadDeltaDto,
  UpdateProfileDto,
  BlockDto,
} from '../dto/user.dto.js';
import { UserBlockService } from '../user-block/user-block.service.js';
import {
  FederationService,
  type S2SProfile,
} from '../federation/federation.service.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { InviteService } from '../invite/invite.service.js';
import { Raw } from '../common/raw.decorator.js';
import { formatSseFrame, initSseResponse } from '../common/sse-stream.js';

/**
 * One entry of the unified client-state delta (`POST /user/query-state/delta`). ADD entries carry the fully
 * hydrated {@link ConversationItemDto} inline (peer/group/unread) so the client applies a single response —
 * no second batch-hydrate round-trip. DELETE entries carry the threadId only: the thread is leaving the
 * caller's roster, so there is nothing to render. The `direction` field discriminates the two.
 */
type HydratedThreadDeltaOp =
  | { threadId: number; direction: 'ADD'; item: ConversationItemDto }
  | { threadId: number; direction: 'DELETE' }
  | { direction: 'PROFILE'; user: UserResponseDto }
  | {
      direction: 'PROFILE_DELETE';
      userId: number;
      account: string;
      domain: string;
      revision: number;
    }
  | {
      direction: 'MEMBER_PROFILE';
      sourcePeerDomain: string;
      memberAccount: string;
      memberDomain: string;
      threadIds: number[];
      revision: number;
    }
  | { direction: 'FRIEND_REQUEST'; revision: number };

type ParticipantWithThread = typeof threadParticipant.$inferSelect & {
  thread: typeof messageThread.$inferSelect;
};

function nextUtcMidnight(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}

@ApiTags('user')
@Controller()
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly participantService: ThreadParticipantService,
    private readonly authService: AuthService,
    private readonly groupService: GroupService,
    private readonly uploadService: UploadService,
    private readonly sseService: SseService,
    private readonly messageService: MessageService,
    private readonly userBlockService: UserBlockService,
    private readonly federationService: FederationService,
    private readonly threadRevisionService: ThreadRevisionService,
    private readonly userQuotaService: UserQuotaService,
    private readonly inviteService: InviteService,
    @Optional()
    @Inject(forwardRef(() => MessageFanoutService))
    private readonly messageFanout?: Pick<MessageFanoutService, 'dispatch'>,
  ) {}

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/my-profile')
  @ApiOperation({ summary: 'Get the current user profile' })
  @ApiResultResponse(UserResponseDto)
  async getMyProfile(@Request() req: FastifyRequest) {
    // findSelfProfile omits hashPwd. Friend-request notification state travels in the unified state delta;
    // its seen cursor is local to each device.
    return this.userService.findSelfProfile(req.user.userId);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/my-quota')
  @ApiOperation({
    summary:
      "View the current local account's effective quota and today's usage",
  })
  async getMyQuota(@Request() req: FastifyRequest) {
    const state = await this.userQuotaService.getState(req.user.userId);
    return {
      usage: state.usage,
      breaker: state.breaker,
      resetAt: nextUtcMidnight().toISOString(),
    };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/update-avatar')
  @ApiOperation({
    summary:
      'Update the current user avatar (multipart file; sharp rewrites to 32/64/128/256/512 multi-size webp)',
  })
  @ApiConsumes('multipart/form-data')
  async updateAvatar(@Request() req: FastifyRequest) {
    const img = await this.uploadService.consumeImage(req);
    if (img.kind === 'rejected') {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        img.reason === 'no-file'
          ? 'no file'
          : img.reason === 'too-large'
            ? 'file too large'
            : 'invalid image',
      );
    }
    // Magic-number check first: quickly reject non-images with a forged mimetype (sharp re-validates in saveAvatars).
    if (!this.uploadService.isImage(img.mimetype, img.buffer)) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid image',
      );
    }
    // Write new multi-size avatar → update DB. The previous avatar files are intentionally LEFT on
    // disk: gcOrphanedAvatars reaps them once they are no longer any User/Group's current avatar, so
    // there is no delete racing a still-rendering <img> on another device/tab.
    let url: string;
    try {
      url = await this.uploadService.saveAvatars(img.buffer);
    } catch {
      // sharp decode failure (corrupt / pixel-bomb / non-image) → always rejected as invalid image; nothing written to disk or DB.
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid image',
      );
    }
    const updated = await this.userService.updateAvatar(req.user.userId, url);
    // Self-profile-rev push so the editor's OTHER tabs/devices learn their own profile changed and re-
    // fetch (multi-device self refresh); the native HELLO cache also merges it for a fresh webview replay.
    return { avatar: url };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/update-profile')
  @ApiOperation({
    summary:
      'Update the current user display name / bio (account is immutable)',
  })
  @ApiResultResponse(UserResponseDto)
  async updateProfile(
    @Request() req: FastifyRequest,
    @Body() dto: UpdateProfileDto,
  ) {
    const data = await this.userService.updateProfile(req.user.userId, dto);
    // Self-profile-rev push (multi-device self refresh + native HELLO-cache merge). See updateAvatar.
    return data;
  }

  /**
   * The single conversation-row hydration pipeline — turns ThreadParticipant rows (with `thread`
   * included) into rendered ConversationItemDtos: batched unread counts, P2P peer users + blocked flags,
   * GROUP info, and the pinned/recent sort. Shared by /user/query-state/delta (hydrates the net-ADD ops)
   * and /user/thread-info (single) so the two can never drift on what a list row looks like. Carries NO
   * preview body — the client derives previews local-first from its message store.
   */
  private async hydrateConversationItems(
    me: number,
    list: ParticipantWithThread[],
  ) {
    // Count + semantic mention come from the same unread range query; they must never disagree about the
    // caller's read watermark or own-message exclusion.
    const self = await this.userService.findUniqueUser({ id: me });
    const attention = self
      ? await this.messageService.unreadAttentionByThread(
          me,
          self.account,
          list.map((p) => p.threadId),
        )
      : new Map();
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
    const peerActiveByThread = new Map(
      peers.map((p) => [p.threadId, p.leftAt === null]),
    );
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
    const groupByThread =
      await this.groupService.resolveGroupUsersByThreadIds(groupThreadIds);
    return list.map((p) => {
      const item = {
        id: p.id,
        threadId: p.threadId,
        type: p.thread.type,
        lastReadSeq: p.lastReadSeq ?? undefined,
        role: p.role ?? undefined,
        unreadCount: attention.get(p.threadId)?.count ?? 0,
        mentionUnread: attention.get(p.threadId)?.mention ?? [],
        // The list preview is NOT embedded — the client derives it from its local message store
        // (local-first). lastMessageAt stays (cheap, needed for sort). lastMessageSeq is the mark-read target
        // the client passes when opening the thread (mark all current up to this seq).
        lastMessageAt: p.thread.lastMessageAt ?? null,
        lastMessageSeq: p.thread.lastMessageSeq ?? null,
        // Per-user display state: mute (notification suppression), pin (top-tier ordering), and the
        // Per-user clear-history watermark (query-messages hides rows through this seq for this user).
        muted: p.muted,
        blocked: p.blocked,
        pinned: p.pinned,
        pinnedAt: p.pinnedAt ?? null,
        clearedSeq: p.clearedSeq ?? null,
        alias: p.alias ?? null,
        conversationState: p.leftAt === null ? 'ACTIVE' : 'READ_ONLY',
      } as {
        id: number;
        threadId: number;
        type: MessageThreadType;
        lastReadSeq: number | undefined;
        role: GroupRole | undefined;
        unreadCount: number;
        lastMessageAt: Date | null;
        muted: boolean;
        pinned: boolean;
        pinnedAt: Date | null;
        clearedSeq: number | null;
        blocked: boolean;
        friendshipActive?: boolean;
        conversationState: 'ACTIVE' | 'READ_ONLY';
        alias: string | null;
        peerUser?: unknown;
        group?: unknown;
      };
      if (p.thread.type === 'P2P') {
        item.friendshipActive =
          p.leftAt === null && peerActiveByThread.get(p.threadId) === true;
        item.conversationState = item.friendshipActive ? 'ACTIVE' : 'READ_ONLY';
        const peerId = peerByThread.get(p.threadId);
        if (peerId !== undefined) {
          item.peerUser = userDict[peerId];
          item.blocked = item.blocked || blockedPeers.has(peerId);
        }
      } else {
        const gu = groupByThread.get(p.threadId);
        item.group = gu
          ? {
              id: p.threadId,
              account: gu.account,
              threadId: p.threadId,
              name: gu.name,
              avatar: gu.avatar,
              profileRev: gu.profileRev,
              description: gu.bio,
              domain: !gu.domain || gu.domain === 'local' ? '' : gu.domain,
              ownerId: gu.group?.ownerId ?? 0,
              dissolvedAt: gu.group?.dissolvedAt ?? null,
              membersCanInvite: gu.group?.membersCanInvite ?? true,
              createdAt: gu.group?.createdAt ?? p.thread.createdAt,
              updatedAt: gu.group?.updatedAt ?? p.thread.updatedAt,
            }
          : undefined;
        item.conversationState =
          p.leftAt === null && gu?.group?.dissolvedAt == null
            ? 'ACTIVE'
            : 'READ_ONLY';
      }
      return item;
    });
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/query-state/delta')
  @ApiOperation({
    summary:
      'Fetch the thread-list delta (from excl, to incl): ADD ops returned hydrated (peer/group/unread), DELETE ops id-only',
  })
  async queryThreadDelta(
    @Request() req: FastifyRequest,
    @Body() dto: ThreadDeltaDto,
  ) {
    const me = req.user.userId;
    // Read the raw ADD/DELETE op log in (from, to], then plan it (last-op-wins per thread). The client
    // applies a single response: it never re-plans or batch-hydrates — the server is authoritative on both.
    const [ops, profileOps, memberProfileOps, friendRequestRevision] =
      await Promise.all([
        this.threadRevisionService.queryDelta(
          me,
          dto.fromRevision,
          dto.toRevision,
        ),
        this.threadRevisionService.queryProfileDelta(
          me,
          dto.fromRevision,
          dto.toRevision,
        ),
        this.threadRevisionService.queryMemberProfileDelta(
          me,
          dto.fromRevision,
          dto.toRevision,
        ),
        this.threadRevisionService.queryFriendRequestStateDelta(
          me,
          dto.fromRevision,
          dto.toRevision,
        ),
      ]);
    const { addIds, removeIds } = planThreadDelta(ops);
    // Hydrate ONLY the net-ADD threads in one batched pass. leftAt:null is the strict "currently a member"
    // guard; a net-ADD whose participant row is gone (a reaped edge) simply drops — the client won't insert
    // it. DELETE entries carry no info (the thread is leaving the roster, nothing to render).
    let adds: ConversationItemDto[] = [];
    if (addIds.length > 0) {
      const rows = await this.participantService.queryParticipants({
        where: {
          userId: me,
          threadId: { in: addIds },
        },
        include: { thread: true },
      });
      // hydrateConversationItems is the ConversationItem pipeline (peer/group/unread) shared with
      // /user/thread-info; its inferred return carries `unknown` peer/group, so assert the contract here.
      adds = (await this.hydrateConversationItems(
        me,
        rows,
      )) as ConversationItemDto[];
    }
    const profiles = await this.userService.queryUsers({
      where: {
        id: { in: profileOps.map((op) => op.subjectUserId) },
      },
    });
    const profileById = new Map(
      profiles.map((profile) => [profile.id, profile]),
    );
    const hydratedProfiles: HydratedThreadDeltaOp[] = [];
    for (const op of profileOps) {
      const profile = profileById.get(op.subjectUserId);
      if (!profile) continue;
      if (profile.isDeleted) {
        hydratedProfiles.push({
          direction: 'PROFILE_DELETE',
          userId: profile.id,
          account: profile.account,
          domain: profile.domain,
          revision: op.revision,
        });
      } else {
        hydratedProfiles.push({
          direction: 'PROFILE',
          user: {
            ...profile,
            createdAt: profile.createdAt.getTime(),
            updatedAt: profile.updatedAt.getTime(),
          },
        });
      }
    }
    return [
      ...(friendRequestRevision === null
        ? []
        : [
            {
              direction: 'FRIEND_REQUEST' as const,
              revision: friendRequestRevision,
            },
          ]),
      ...hydratedProfiles,
      ...memberProfileOps.map((op) => ({
        direction: 'MEMBER_PROFILE' as const,
        ...op,
      })),
      ...adds.map((item) => ({
        threadId: item.threadId,
        direction: 'ADD' as const,
        item,
      })),
      ...removeIds.map((threadId) => ({
        threadId,
        direction: 'DELETE' as const,
      })),
    ] satisfies HydratedThreadDeltaOp[];
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/delete-friend')
  @ApiOperation({ summary: 'Unfriend — end a P2P conversation (mutual)' })
  async deleteFriend(
    @Request() req: FastifyRequest,
    @Body() dto: DeleteFriendDto,
  ) {
    const me = req.user.userId;
    if (me === dto.userId) {
      throw new BusinessException(
        BusinessCode.FRIEND_SELF,
        'can not unfriend self',
      );
    }
    const peer = await this.userService.findUniqueUser({ id: dto.userId });
    // Prefer the active edge. If it has already ended, retain the latest historical edge so a retry is
    // successful and may still apply the caller's `deleteData` choice.
    const activeThreadId = await this.participantService.findP2PThreadBetween(
      me,
      dto.userId,
    );
    const threadId =
      activeThreadId ??
      (await this.participantService.findLatestP2PThreadBetween(
        me,
        dto.userId,
      ));
    if (threadId === null) {
      throw new BusinessException(
        BusinessCode.FRIEND_NOT_FOUND,
        `not friends with [${dto.userId}]`,
      );
    }
    // End the friendship but retain both participant rows + the thread as a readable history item.
    const ended = await this.participantService.endP2P(
      threadId,
      me,
      dto.deleteData ?? false,
      peer?.isForeigner ? undefined : dto.userId,
    );
    await Promise.allSettled(
      ended.statePeers.map((domain) =>
        this.federationService.pushDiscoveryHwm(domain),
      ),
    );
    const systemMessage =
      ended.transitioned && activeThreadId !== null
        ? await this.messageService.tryWriteSystemMessage(
            me,
            threadId,
            SystemMessageType.FRIEND_REMOVED,
            dto.userId,
          )
        : null;
    if (systemMessage && this.messageFanout) {
      void this.messageFanout.dispatch(systemMessage);
    }
    return envelope(undefined, { message: 'friend removed' });
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/block')
  @ApiOperation({
    summary:
      'Block / unblock a user (P2P). Independent of friendship; the message path drops delivery + hides their messages.',
  })
  async setBlock(@Request() req: FastifyRequest, @Body() dto: BlockDto) {
    if (req.user.userId === dto.userId) {
      throw new BusinessException(
        BusinessCode.FRIEND_SELF,
        'can not block self',
      );
    }
    if (dto.block) {
      await this.userBlockService.block(req.user.userId, dto.userId);
    } else {
      await this.userBlockService.unblock(req.user.userId, dto.userId);
    }
    // No peer SSE: a block never reveals itself to the blocked user. The blocker's own other devices
    // will refetch the thread view to show the blocked banner; no live frame is needed for correctness.
    return envelope(undefined, {
      message: dto.block ? 'user blocked' : 'user unblocked',
    });
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/query')
  @ApiOperation({ summary: 'Look up users by userId in batch (≤100)' })
  @ApiResultResponse(UserResponseDto, true)
  async queryUserBase(@Body() dto: QueryUsersDto) {
    return this.userService.queryUsers({
      where: { id: { in: dto.userIds }, isDeleted: false },
    });
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/peer-trust-status')
  @ApiOperation({
    summary:
      'Pre-flight: is mutual trust with a peer domain already established? Drives the first-contact "connecting…" affordance on a federated address search.',
  })
  async peerTrustStatus(@Body() dto: PeerTrustStatusDto) {
    // Pure local allow-list lookup (no network) — tells the client whether the upcoming federated
    // resolve will run bidirectional recognition (first contact → banner) or resolve fast
    // (trusted → no banner). A known server-side fact, not a latency guess: the rare
    // already-trusted-but-failing case (peer reset / broken key → re-handshake) surfaces as an error
    // from the resolve itself, not here.
    const trusted = await this.federationService.isPeerTrusted(dto.domain);
    return { trusted };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/resolve')
  @ApiOperation({
    summary: 'Resolve a local user by account',
  })
  @ApiResultResponse(UserResponseDto)
  async resolveUser(@Body() dto: UserResolveDto) {
    const account = normalizeAccount(dto.account);
    const { domain } = dto;
    if (domain && domain !== this.federationService.ourDomain) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'federated lookup requires resolve-federated-stream',
      );
    }
    // No domain, or our own domain, is a local account lookup.
    const user = await this.userService.findUniqueUser({
      account_domain: { account: account, domain: 'local' },
      isDeleted: false,
    });
    if (user !== null) {
      if (user.isGroup) {
        throw new BusinessException(
          BusinessCode.FRIEND_INVALID_TARGET,
          'cannot add a group as a friend',
        );
      }
      return user;
    }
    throw new BusinessException(
      BusinessCode.NOT_FOUND,
      `can not find user [${account}]`,
    );
  }

  /** Temporary resolve stream. It has one terminal result and never materializes a User stub. The
   * browser may close it at any time; the peer request retains its normal bounded S2S timeout. */
  @Raw()
  @ApiBearerAuth()
  @Get('user/resolve-federated-stream')
  async resolveFederatedUserStream(
    @Request() req: FastifyRequest,
    @Query() dto: UserResolveDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    reply.hijack();
    const heartbeat = initSseResponse(reply.raw, req.headers.origin);
    let closed = false;
    const finish = (event: string, data: unknown) => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      reply.raw.write(formatSseFrame(event, data));
      reply.raw.end();
    };
    reply.raw.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
    });
    const account = normalizeAccount(dto.account);
    const domain = dto.domain?.trim().toLowerCase() ?? '';
    if (!domain || domain === this.federationService.ourDomain) {
      finish('failed', { reason: 'INVALID_ADDRESS' });
      return;
    }
    const deadline = new Promise<never>((_, reject) => {
      const handle = setTimeout(
        () => reject(new Error('resolve deadline exceeded')),
        30_000,
      );
      reply.raw.once('close', () => clearTimeout(handle));
    });
    try {
      const profile = await Promise.race([
        (async () => {
          await this.federationService.ensurePeerTrusted(domain);
          return this.federationService.fetchRemoteUser({ account, domain });
        })(),
        deadline,
      ]);
      const relationship = await this.inviteService.federatedRelationshipStatus(
        req.user.userId,
        account,
        domain,
      );
      finish('resolved', {
        user: this.transientFederatedUser(profile),
        relationship,
      });
    } catch (error) {
      finish('failed', {
        reason:
          (error as Error).message === 'resolve deadline exceeded'
            ? 'TIMEOUT'
            : error instanceof BusinessException &&
                error.bizCode === BusinessCode.FEDERATION_PEER_BLOCKED
              ? 'BLOCKED'
              : 'UNREACHABLE',
      });
    }
  }

  private transientFederatedUser(profile: S2SProfile) {
    const now = Date.now();
    return {
      id: 0,
      account: profile.account,
      name: profile.displayName,
      avatar: profile.avatar
        ? `data:image/webp;base64,${profile.avatar.b64}`
        : '',
      bio: profile.bio,
      isForeigner: true,
      isGroup: false,
      domain: profile.domain,
      createdAt: now,
      updatedAt: now,
      isDeleted: false,
      profileRev: 0,
      remoteProfileRev: profile.profileRev,
      mustChangePassword: false,
    };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/search')
  @ApiOperation({
    summary:
      'Fuzzy local user discovery by account OR display name (local users only)',
  })
  async searchUsers(@Body() dto: UserSearchDto) {
    // Discovery endpoint — the two abuse guardrails are the DTO's @MinLength(2) on q and the hard
    // take cap here (a client must never page through the whole user table). Federated users are not
    // discoverable: resolve those by exact account + domain via /user/resolve. Only local,
    // non-deleted accounts are returned.
    const take = Math.min(dto.take ?? 20, 20);
    return this.userService.searchUsers(dto.q.trim(), {
      skip: dto.skip ?? 0,
      take,
    });
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('/user/thread-info')
  @ApiOperation({
    summary: 'Get conversation details (includes peer user/group)',
  })
  @ApiResultResponse(ConversationItemDto)
  async queryUserThreadInfo(
    @Request() req: FastifyRequest,
    @Body() dto: ThreadIdDto,
  ) {
    const me = req.user.userId;
    const [p] = await this.participantService.queryParticipants({
      where: {
        userId: me,
        threadId: dto.threadId,
      },
      include: { thread: true },
      take: 1,
    });
    if (!p) {
      // Non-membership / no-such-thread collapse to THREAD_NOT_FOUND — the same code the message
      // routes return via ThreadAccessGuard, so a client gets one consistent "no conversation"
      // signal across thread-info / send / query / mark-read.
      throw new BusinessException(
        BusinessCode.THREAD_NOT_FOUND,
        `no thread [${dto.threadId}]`,
      );
    }
    const [data] = await this.hydrateConversationItems(me, [p]);
    return data;
  }

  @Public()
  @ApiTags('auth')
  @HttpCode(HttpStatus.OK)
  @Post('user/register')
  @ApiOperation({ summary: 'Register a new user' })
  async registerLocal(@Body() dto: RegisterDto) {
    // Self-registration gate: when the site is in admin-provisioned mode (registrationOpen=false) the
    // register endpoint refuses up front — accounts come from POST admin/users/create instead. The
    // registration logic below is untouched; only this switch is added.
    if (!PUBLIC_CONFIG.registrationOpen) {
      throw new BusinessException(
        BusinessCode.REGISTRATION_DISABLED,
        'registration is closed',
      );
    }
    /* Format validation (regex) for account/password has moved into RegisterDto's @Matches → failures
       go through ValidationPipe → 200/10000. Business validation (account duplicate) stays in the
       service → 200 + ALREADY_EXISTS. */
    const res = await this.userService.addUser({
      account: dto.account,
      name: dto.name,
      hashPwd: await this.authService.hashPassword(dto.password),
    });
    if (res.status === 2) {
      throw new BusinessException(
        BusinessCode.ALREADY_EXISTS,
        `User ${dto.account} already exists`,
      );
    }
    return envelope(res.data, { message: 'successfuly registered' });
  }
}
