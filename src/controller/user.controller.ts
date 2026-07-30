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
import {
  GroupRole,
  MessageThreadType,
  Prisma,
} from '../prisma/generated/client.js';
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
import {
  ConversationItemDto,
  UserResponseDto,
} from '../dto/response.dto.js';
import { RegisterDto } from '../dto/auth.dto.js';
import {
  UserIdDto,
  SyncPeerProfileDto,
  SyncSelfProfileDto,
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
import { FederationService, type S2SProfile } from '../federation/federation.service.js';

/**
 * One entry of the hydrated thread-list delta (`POST /user/query-thread/delta`). ADD entries carry the fully
 * hydrated {@link ConversationItemDto} inline (peer/group/unread) so the client applies a single response —
 * no second batch-hydrate round-trip. DELETE entries carry the threadId only: the thread is leaving the
 * caller's roster, so there is nothing to render. The `direction` field discriminates the two.
 */
type HydratedThreadDeltaOp =
  | { threadId: number; direction: 'ADD'; item: ConversationItemDto }
  | { threadId: number; direction: 'DELETE' };

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
  ) {}

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/my-profile')
  @ApiOperation({ summary: 'Get the current user profile' })
  @ApiResultResponse(UserResponseDto)
  async getMyProfile(@Request() req: FastifyRequest) {
    // findSelfProfile omits hashPwd. The friend-request badge is no longer a self-profile field — it is
    // derived client-side from the HELLO/push-carried `friendReqRev` vs friendReqAckRev (server-state).
    return this.userService.findSelfProfile(req.user.userId);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/sync-self-profile')
  @ApiOperation({
    summary:
      'ACK-only self-profile revision probe. Pushes PROFILE_REV_UPDATED when the caller cache is stale.',
  })
  async syncSelfProfile(@Request() req: FastifyRequest, @Body() dto: SyncSelfProfileDto): Promise<void> {
    const data = await this.userService.findUniqueUser({ id: req.user.userId });
    if (data && data.profileRev > dto.sinceProfileRev) {
      this.sseService.onProfileRevUpdated(req.user.userId, { profileRev: data.profileRev });
    }
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
      throw new BusinessException(BusinessCode.VALIDATION_FAILED, 'invalid image');
    }
    // Write new multi-size avatar → update DB. The previous avatar files are intentionally LEFT on
    // disk: gcOrphanedAvatars reaps them once they are no longer any User/Group's current avatar, so
    // there is no delete racing a still-rendering <img> on another device/tab.
    let url: string;
    try {
      url = await this.uploadService.saveAvatars(img.buffer);
    } catch {
      // sharp decode failure (corrupt / pixel-bomb / non-image) → always rejected as invalid image; nothing written to disk or DB.
      throw new BusinessException(BusinessCode.VALIDATION_FAILED, 'invalid image');
    }
    const updated = await this.userService.updateAvatar(req.user.userId, url);
    // Fan the fresh avatar to every P2P friend so their conversation list (and open chat header)
    // refreshes in real time. Fire-and-forget — never blocks the upload response.
    void this.federationService.notifyPeersOfProfileUpdate(req.user.userId);
    // Self-profile-rev push so the editor's OTHER tabs/devices learn their own profile changed and re-
    // fetch (multi-device self refresh); the native HELLO cache also merges it for a fresh webview replay.
    void this.sseService.onProfileRevUpdated(req.user.userId, { profileRev: updated.profileRev });
    return { avatar: url };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/update-profile')
  @ApiOperation({ summary: 'Update the current user display name / bio (account is immutable)' })
  @ApiResultResponse(UserResponseDto)
  async updateProfile(@Request() req: FastifyRequest, @Body() dto: UpdateProfileDto) {
    const data = await this.userService.updateProfile(req.user.userId, dto);
    // Fan the fresh profile to every P2P friend so their conversation list (and open chat header)
    // refreshes in real time. Fire-and-forget — never blocks the edit response.
    void this.federationService.notifyPeersOfProfileUpdate(req.user.userId);
    // Self-profile-rev push (multi-device self refresh + native HELLO-cache merge). See updateAvatar.
    void this.sseService.onProfileRevUpdated(req.user.userId, { profileRev: data.profileRev });
    return data;
  }

  /**
   * The single conversation-row hydration pipeline — turns ThreadParticipant rows (with `thread`
   * included) into rendered ConversationItemDtos: batched unread counts, P2P peer users + blocked flags,
   * GROUP info, and the pinned/recent sort. Shared by /user/query-thread/delta (hydrates the net-ADD ops)
   * and /user/thread-info (single) so the two can never drift on what a list row looks like. Carries NO
   * preview body — the client derives previews local-first from its message store.
   */
  private async hydrateConversationItems(
    me: number,
    list: Prisma.ThreadParticipantGetPayload<{ include: { thread: true } }>[],
  ) {
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
    const groupByThread =
      await this.groupService.resolveGroupUsersByThreadIds(groupThreadIds);
    return list.map((p) => {
      const item = {
        id: p.id,
        threadId: p.threadId,
        type: p.thread.type,
        lastReadSeq: p.lastReadSeq ?? undefined,
        role: p.role ?? undefined,
        unreadCount: unread.get(p.threadId) ?? 0,
        // The list preview is NOT embedded — the client derives it from its local message store
        // (local-first). lastMessageAt stays (cheap, needed for sort). lastMessageSeq is the mark-read target
        // the client passes when opening the thread (mark all current up to this seq).
        lastMessageAt: p.thread.lastMessageAt ?? null,
        lastMessageSeq: p.thread.lastMessageSeq ?? null,
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
        lastReadSeq: number | undefined;
        role: GroupRole | undefined;
        unreadCount: number;
        lastMessageAt: Date | null;
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
        const gu = groupByThread.get(p.threadId);
        item.group = gu
          ? {
              id: p.threadId,
              threadId: p.threadId,
              name: gu.name,
              avatar: gu.avatar,
              description: gu.bio,
              domain: !gu.domain || gu.domain === 'local' ? '' : gu.domain,
              ownerId: gu.group?.ownerId ?? 0,
              createdAt: gu.group?.createdAt ?? p.thread.createdAt,
              updatedAt: gu.group?.updatedAt ?? p.thread.updatedAt,
            }
          : undefined;
      }
      return item;
    });
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/query-thread/delta')
  @ApiOperation({
    summary:
      'Fetch the thread-list delta (from excl, to incl): ADD ops returned hydrated (peer/group/unread), DELETE ops id-only',
  })
  async queryThreadDelta(@Request() req: FastifyRequest, @Body() dto: ThreadDeltaDto) {
    const me = req.user.userId;
    // Read the raw ADD/DELETE op log in (from, to], then plan it (last-op-wins per thread). The client
    // applies a single response: it never re-plans or batch-hydrates — the server is authoritative on both.
    const ops = await this.threadRevisionService.queryDelta(me, dto.fromRevision, dto.toRevision);
    const { addIds, removeIds } = planThreadDelta(ops);
    // Hydrate ONLY the net-ADD threads in one batched pass. leftAt:null is the strict "currently a member"
    // guard; a net-ADD whose participant row is gone (a reaped edge) simply drops — the client won't insert
    // it. DELETE entries carry no info (the thread is leaving the roster, nothing to render).
    let adds: ConversationItemDto[] = [];
    if (addIds.length > 0) {
      const rows = await this.participantService.queryParticipants({
        where: { userId: me, threadId: { in: addIds }, leftAt: null },
        include: { thread: true },
      });
      // hydrateConversationItems is the ConversationItem pipeline (peer/group/unread) shared with
      // /user/thread-info; its inferred return carries `unknown` peer/group, so assert the contract here.
      adds = (await this.hydrateConversationItems(me, rows)) as ConversationItemDto[];
    }
    return [
      ...adds.map((item) => ({ threadId: item.threadId, direction: 'ADD' as const, item })),
      ...removeIds.map((threadId) => ({ threadId, direction: 'DELETE' as const })),
    ] satisfies HydratedThreadDeltaOp[];
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/delete-friend')
  @ApiOperation({ summary: 'Unfriend — end a P2P conversation (mutual)' })
  async deleteFriend(@Request() req: FastifyRequest, @Body() dto: UserIdDto) {
    const me = req.user.userId;
    if (me === dto.userId) {
      throw new BusinessException(BusinessCode.FRIEND_SELF, 'can not unfriend self');
    }
    const peer = await this.userService.findUniqueUser({ id: dto.userId });
    // A friend relationship == an active P2P thread shared by both. No thread → nothing to end
    // (idempotent). FRIEND_NOT_FOUND signals the caller has no friendship edge to end (distinct from the
    // generic THREAD_NOT_FOUND the read paths use for a missing conversation).
    const threadId = await this.participantService.findP2PThreadBetween(me, dto.userId);
    if (threadId === null) {
      throw new BusinessException(BusinessCode.FRIEND_NOT_FOUND, `not friends with [${dto.userId}]`);
    }
    // Soft-leave BOTH participants in one shot. The thread row + participants stay (history), but the
    // edge is severed (findP2PThreadBetween now returns null); re-friending later mints a fresh thread.
    await this.participantService.softLeaveP2PBoth(threadId);
    // Record the thread delete (bump threadRevision + push THREAD_REVISION_UPDATED) — replaces the
    // former FRIEND_DELETED NOTIFY. Local peer: both users' lists drop it; federated peer: only me
    // (the peer's thread list lives on their origin server; they discover the severance lazily via a
    // 403 on the next /messages pull).
    await this.threadRevisionService.recordThreadDelete(me, threadId);
    if (!peer?.isForeigner) {
      await this.threadRevisionService.recordThreadDelete(dto.userId, threadId);
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
      throw new BusinessException(BusinessCode.FRIEND_SELF, 'can not block self');
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
    // resolve will run the init handshake (untrusted → first contact → banner) or resolve fast
    // (trusted → no banner). A known server-side fact, not a latency guess: the rare
    // already-trusted-but-failing case (peer reset / broken key → re-handshake) surfaces as an error
    // from the resolve itself, not here.
    const trusted = await this.federationService.isPeerTrusted(dto.domain);
    return { trusted };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/resolve')
  @ApiOperation({ summary: 'Resolve a user by {account, domain} (local lookup, or federated via S2S)' })
  @ApiResultResponse(UserResponseDto)
  async resolveUser(@Body() dto: UserResolveDto) {
    const account = normalizeAccount(dto.account);
    const { domain } = dto;
    // Federated (account + a peer domain != ours) → establish mutual trust (init handshake, if not
    // already trusted), fetch the peer's profile (avatar inline as base64), find-or-create a stub, and
    // localize it (persist the avatar via saveAvatars + write name/bio), so the caller can address the
    // user by id in subsequent friend ops (same as a local lookup).
    if (domain && domain !== this.federationService.ourDomain) {
      try {
        // Trust prerequisite: the signed profile GET below is allow-list-gated on the peer, and our
        // guard gates their reply traffic — so mutual trust must exist first. Idempotent (no-op if
        // already trusted). The peer auto-accepts us via the init handshake.
        await this.federationService.ensurePeerTrusted(domain);
      } catch (e) {
        if (e instanceof BusinessException && e.bizCode === BusinessCode.FEDERATION_PEER_BLOCKED) {
          // Admin intent — distinct from an unreachable peer so the client can show "blocked by admin".
          throw new BusinessException(
            BusinessCode.FEDERATION_PEER_BLOCKED,
            `${domain} is blocked by an admin`,
          );
        }
        throw new BusinessException(
          BusinessCode.FEDERATION_DELIVERY_FAILED,
          `could not establish trust with ${domain}: ${(e as Error).message}`,
        );
      }
      let profile: S2SProfile;
      try {
        profile = await this.federationService.fetchRemoteUser({ account, domain });
      } catch (e) {
        throw new BusinessException(
          BusinessCode.FEDERATION_DELIVERY_FAILED,
          `could not reach ${domain}: ${(e as Error).message}`,
        );
      }
      const foreignId = await this.federationService.ensureForeignUser(account, domain);
      await this.federationService.localizeForeignProfile(foreignId, profile);
      // Return the localized stub (avatar is now a /uploads/* URL, not the wire base64).
      return this.userService.findUniqueUser({ id: foreignId });
    }
    // Local: no domain, or a domain equal to ours → look up by account.
    const user = await this.userService.findUniqueUser({
      account_domain: { account: account, domain: 'local' },
      isDeleted: false,
    });
    if (user !== null) {
      if (user.isGroup) {
        throw new BusinessException(BusinessCode.FRIEND_INVALID_TARGET, 'cannot add a group as a friend');
      }
      return user;
    }
    throw new BusinessException(BusinessCode.NOT_FOUND, `can not find user [${account}]`);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/search')
  @ApiOperation({
    summary: 'Fuzzy local user discovery by account OR display name (local users only)',
  })
  async searchUsers(@Body() dto: UserSearchDto) {
    // Discovery endpoint — the two abuse guardrails are the DTO's @MinLength(2) on q and the hard
    // take cap here (a client must never page through the whole user table). Federated users are not
    // discoverable: resolve those by exact account + domain via /user/resolve. Only local,
    // non-deleted accounts are returned.
    const take = Math.min(dto.take ?? 20, 20);
    return this.userService.searchUsers(dto.q.trim(), { skip: dto.skip ?? 0, take });
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/sync-peer-profile')
  @ApiOperation({
    summary:
      'Refresh a peer profile if stale (chat-open / profile-panel-open hook). Federated: probes the peer /revision and re-pulls avatar/name/bio only when newer; local: authoritative in-DB. ACK-only — returns no payload; pass sinceProfileRev so a stale local peer is pushed a PEER_PROFILE_UPDATED signal to pull.',
  })
  @ApiResultResponse(UserResponseDto)
  async syncPeerProfile(@Request() req: FastifyRequest, @Body() dto: SyncPeerProfileDto): Promise<void> {
    // Chat-open / profile-panel-open staleness hook. Federated: probe the peer's /revision; if newer than
    // the stub's remoteProfileRev, re-pull + re-localize avatar/name/bio (no-op for local users). Runs
    // ASYNC — the response returns immediately; a re-localized stub fans a PEER_PROFILE_UPDATED signal on
    // completion, so the caller pulls then. Best-effort — a transient peer outage keeps the cached profile.
    void this.federationService.syncForeignUserIfStale(dto.userId);
    // Message catch-up (§4.4): recover any hint dropped by the debounce / a lost push. Fire-and-forget.
    void this.federationService.syncMessagesWithPeerByStubId(dto.userId, req.user.userId);
    // Local comparison: if the caller's cached profileRev is stale, push a signal so it pulls. Federated
    // stale is covered by syncForeignUserIfStale's notify above; this covers the local case (and is a
    // harmless duplicate for federated — the pull is idempotent).
    const data = await this.userService.findUniqueUser({ id: dto.userId });
    if (data && dto.sinceProfileRev !== undefined && data.profileRev > dto.sinceProfileRev) {
      this.sseService.onPeerProfileUpdated(req.user.userId, { userId: dto.userId });
    }
    // ACK-only — no profile payload. The client pulls on receipt of the signal.
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('/user/thread-info')
  @ApiOperation({ summary: 'Get conversation details (includes peer user/group)' })
  @ApiResultResponse(ConversationItemDto)
  async queryUserThreadInfo(@Request() req: FastifyRequest, @Body() dto: ThreadIdDto) {
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
      throw new BusinessException(BusinessCode.THREAD_NOT_FOUND, `no thread [${dto.threadId}]`);
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
      throw new BusinessException(BusinessCode.REGISTRATION_DISABLED, 'registration is closed');
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
      throw new BusinessException(BusinessCode.ALREADY_EXISTS, `User ${dto.account} already exists`);
    }
    return envelope(res.data, { message: 'successfuly registered' });
  }
}
