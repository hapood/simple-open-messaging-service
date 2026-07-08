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
import { MessageService } from '../message/message.service.js';
import { ContentType, Prisma } from '../prisma/generated/client.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { ApiResult, ApiResultResponse } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { FriendshipDto, MessageResponseDto } from '../dto/response.dto.js';
import { UserIdDto } from '../dto/user.dto.js';
import { SseService } from '../gateway/sse.service.js';
import { PushService } from '../push/push.service.js';
import { NotificationQueryService } from '../notification/notification-query.service.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { ThreadAccessGuard } from '../thread-participant/thread-access.guard.js';
import { ResourceId } from '../common/resource-id.decorator.js';
import { FriendshipService } from '../friendship/friendship.service.js';
import {
  parseAudioContent,
  parseFileContent,
  parseVideoContent,
} from '../upload/file-content.js';
import { UserBlockService } from '../user-block/user-block.service.js';
import { FederationBufferService } from '../federation/federation-buffer.service.js';
import {
  SendMessageDto,
  QueryMessagesDto,
  MarkReadDto,
  SetMutedDto,
  SetPinnedDto,
  ClearHistoryDto,
  SetAliasDto,
  SearchMessagesDto,
} from '../dto/message.dto.js';

@ApiTags('message')
@Controller()
export class MessageController {
  constructor(
    private readonly messageService: MessageService,
    private readonly sseService: SseService,
    private readonly participantService: ThreadParticipantService,
    private readonly friendshipService: FriendshipService,
    private readonly pushService: PushService,
    private readonly notifQuery: NotificationQueryService,
    private readonly userBlockService: UserBlockService,
    private readonly federationBuffer: FederationBufferService,
  ) {}

  @UseGuards(JwtAuthGuard, ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SendMessageDto>('threadId')
  @Throttle(60, 60) // anti-spam ceiling: 60 sends/min
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('send-message')
  @ApiOperation({ summary: 'Send a message (unified for P2P and group)' })
  @ApiResultResponse(MessageResponseDto)
  async sendMessage(
    @Request() req,
    @Body() dto: SendMessageDto,
  ): Promise<ApiResult> {
    // Membership is resolved by ThreadAccessGuard (throws THREAD_NOT_FOUND for non-participants);
    // req.threadAccess.participant is the caller's row. A missing/empty content string is already
    // rejected by SendMessageDto's @IsNotEmpty/@MaxLength via ValidationPipe (HTTP 200 + code 10000);
    // this check only catches whitespace-only bodies (business code MESSAGE_EMPTY).
    if (!dto.content?.trim()) {
      return { code: BusinessCode.MESSAGE_EMPTY, message: 'no content' };
    }
    const contentType = dto.contentType ?? ContentType.PURE_TEXT;
    // Media content (FILE/VIDEO/AUDIO) is a server-trust contract: the client only forwards what
    // the matching POST /upload/* route returned. parse{File,Video,Audio}Content reject any non-upload
    // URL, disallowed mimetype, or bad shape so a forged `javascript:`/external/traversal URL or
    // oversized value can never be stored (and later rendered into a link). PURE_TEXT/IMAGE keep
    // their existing verbatim storage.
    if (contentType === ContentType.FILE && !parseFileContent(dto.content)) {
      return {
        code: BusinessCode.VALIDATION_FAILED,
        message: 'invalid file content',
      };
    }
    if (contentType === ContentType.VIDEO && !parseVideoContent(dto.content)) {
      return {
        code: BusinessCode.VALIDATION_FAILED,
        message: 'invalid video content',
      };
    }
    if (contentType === ContentType.AUDIO && !parseAudioContent(dto.content)) {
      return {
        code: BusinessCode.VALIDATION_FAILED,
        message: 'invalid audio content',
      };
    }
    const data = await this.messageService.writeMsgToThread(
      req.user.userId,
      dto.threadId,
      dto.content,
      contentType,
      dto.clientMessageId,
    );
    // Push the full message body over SSE (serializeBody converts BigInt→string / Date→ms, the same
    // shape as the HTTP response; the client can render it directly without a second query-messages).
    const msgData = serializeBody({ threadId: dto.threadId, ...data });
    // Unified fan-out: every active participant of the thread (P2P = both sides, GROUP = all members).
    // Participants now carry `muted` so the notification channels (push + notif-snapshot) can honor mute.
    const participants = await this.participantService.getActiveParticipantUserIds(
      dto.threadId,
    );
    // BLOCK: a recipient who blocks the sender must not receive the message AT ALL (no SSE, no push,
    // no notif snapshot — the blocked user is invisible to the blocker's message stream).
    const blockers = await this.userBlockService.blockersOf(req.user.userId);
    // SSE: deliver to everyone active except blocking recipients. The sender stays in the set so their
    // own other tabs/devices get the echo (multi-device consistency); block never applies to self.
    const sseTargets = participants.filter((p) => !blockers.has(p.userId));
    sseTargets.forEach((p) => {
      this.sseService.onNewMessage(p.userId, msgData);
    });
    // Notification channels (FCM/Web Push wake-up + Android FGS unread snapshot): additionally exclude
    // MUTED recipients (mute = suppress the heads-up notification, NOT the in-app delivery — the bubble
    // still renders via SSE above) and the sender (foregrounded). Fire-and-forget; push failures never
    // break delivery.
    const notifTargets = sseTargets.filter(
      (p) => !p.muted && p.userId !== req.user.userId,
    );
    void this.pushService.dispatchForMessage(
      notifTargets,
      req.user.userId,
      dto.threadId,
      msgData,
    );
    notifTargets.forEach((p) => {
      const uid = p.userId;
      if (this.sseService.hasNotifClient(uid)) {
        void this.notifQuery
          .buildUnreadSnapshot(uid)
          .then((snapshot) => this.sseService.pushNotifSnapshot(uid, snapshot));
      }
    });
    // Federation Step 2: if the thread has a foreign (federated) participant, mark the conversation
    // dirty in the outbound hint buffer — a debounced /new-msg-map push tells the peer to pull. Local-
    // only / group threads are a no-op inside notifyOnSend. Fire-and-forget (best-effort; pull-on-open
    // is the floor). data.originSeq is always set on a fresh insert (nullable only for legacy rows).
    if (data.originSeq != null) {
      void this.federationBuffer.notifyOnSend(req.user.userId, dto.threadId, data.originSeq);
    }
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  @UseGuards(JwtAuthGuard, ThreadAccessGuard)
  @ResourceId<QueryMessagesDto>('threadId')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('query-messages')
  @ApiOperation({ summary: 'Query conversation history messages (cursor pagination)' })
  @ApiResultResponse(MessageResponseDto, true)
  async queryMessages(
    @Request() req,
    @Body() dto: QueryMessagesDto,
  ): Promise<ApiResult> {
    // Membership is resolved by ThreadAccessGuard (THREAD_NOT_FOUND for non-participants) — the same
    // IDOR fix as send, now declarative. The participant row is on req.threadAccess.participant.
    // take+1 trick: fetch one extra row to decide hasMore, then truncate `data` back to `take` rows.
    // This removes the edge case where a total count that is an exact multiple of `take` would make the
    // client fire one speculative empty request (its `< take` heuristic would otherwise be ambiguous).
    const newParams: Prisma.MessageFindManyArgs = {
      skip: dto.skip,
      take: dto.take + 1,
      orderBy: { id: dto.orderBy },
    };
    if (dto.lastId) {
      newParams.cursor = { id: BigInt(dto.lastId) };
    }
    // Per-viewer filters: clearedAt hides the caller's "clear history" tail (P2P + GROUP), and on P2P
    // threads a blocked peer's messages are hidden (group threads leave blocked members visible —
    // WhatsApp neutral-ground). blockedByMe is empty for ~all users, so the creator filter is skipped.
    const filters: { clearedAfter?: Date | null; hideCreatorIds?: number[] } = {
      clearedAfter: req.threadAccess.participant.clearedAt,
    };
    if (req.threadAccess.threadType === 'P2P') {
      const blocked = await this.userBlockService.blockedByMe(req.user.userId);
      if (blocked.size > 0) filters.hideCreatorIds = [...blocked];
    }
    const rows = await this.messageService.queryMessages(
      dto.threadId,
      newParams,
      filters,
    );
    const hasMore = rows.length > dto.take;
    const data = hasMore ? rows.slice(0, dto.take) : rows;
    return { code: BusinessCode.OK, message: 'successful', data, hasMore };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/by-user-id')
  @ApiOperation({ summary: 'Look up the P2P relationship by peer userId (friend status / thread)' })
  @ApiResultResponse(FriendshipDto)
  async getThreadByUserId(
    @Request() req,
    @Body() dto: UserIdDto,
  ): Promise<ApiResult> {
    const { friendship, isFriend } = await this.friendshipService.getFriendship(
      req.user.userId,
      dto.userId,
    );
    // Only an APPROVED friendship carries a usable P2P thread. Pending / DELETED / no-relationship
    // all collapse to THREAD_NOT_FOUND — deliberately non-leaking, so a caller cannot probe whether
    // a pending request or prior relationship with an arbitrary user exists (nor its direction).
    // Matches ThreadAccessGuard's non-leak policy.
    if (!isFriend || !friendship?.threadId) {
      return {
        code: BusinessCode.THREAD_NOT_FOUND,
        message: `no relationship with user [${dto.userId}]`,
      };
    }
    return { code: BusinessCode.OK, message: 'successful', data: friendship };
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard, ThreadAccessGuard)
  @ResourceId<MarkReadDto>('threadId')
  @Throttle(60, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/mark-read')
  @ApiOperation({
    summary: 'Mark a conversation read (advances the per-user read cursor)',
  })
  async markRead(@Request() req, @Body() dto: MarkReadDto): Promise<ApiResult> {
    // Membership is resolved by ThreadAccessGuard (THREAD_NOT_FOUND for non-participants); the
    // participant row is on req.threadAccess.participant.
    // Resolve the cursor to advance to. With an explicit id, validate it belongs to this thread
    // (prevents pointing the cursor at a message from another conversation). Without one, mark all
    // current messages read by using the thread's denormalized lastMessageId. The numeric-string
    // shape of lastReadMessageId is enforced by MarkReadDto's @Matches.
    let cursor: bigint;
    if (dto.lastReadMessageId !== undefined) {
      const msg = await this.messageService.findMessageById(
        BigInt(dto.lastReadMessageId),
      );
      if (msg === null || msg.threadId !== dto.threadId) {
        return {
          code: BusinessCode.NOT_FOUND,
          message: `no such message in thread [${dto.threadId}]`,
        };
      }
      cursor = msg.id;
    } else {
      const thread = await this.messageService.findThread(dto.threadId);
      const last = thread?.lastMessageId ?? null;
      if (last === null) {
        // Empty thread — nothing to mark read.
        return { code: BusinessCode.OK, message: 'successful' };
      }
      cursor = last;
    }
    const moved = await this.participantService.advanceReadCursor(
      req.user.userId,
      dto.threadId,
      cursor,
    );
    if (moved) {
      // Sync the caller's OTHER online devices/tabs so their unread badge for this thread clears
      // immediately — the same multi-device consistency send-message already provides by fanning
      // NEW_MESSAGE to the sender. advanceReadCursor's "did it move?" return suppresses the frame
      // for an idempotent/stale mark-read (cursor already ≥ this id).
      this.sseService.onReadCursor(
        req.user.userId,
        serializeBody({ threadId: dto.threadId, lastReadMsgId: cursor }),
      );
    }
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SetMutedDto>('threadId')
  @Throttle(30, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/set-muted')
  @ApiOperation({ summary: 'Mute / unmute a conversation (suppresses notifications, not delivery)' })
  async setMuted(@Request() req, @Body() dto: SetMutedDto): Promise<ApiResult> {
    await this.participantService.setMuted(req.user.userId, dto.threadId, dto.muted);
    // Sync the caller's other online devices so their list row swaps the mute icon live (no reload).
    this.sseService.onThreadMeta(
      req.user.userId,
      serializeBody({ event: 'THREAD_META', threadId: dto.threadId, muted: dto.muted }),
    );
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SetPinnedDto>('threadId')
  @Throttle(30, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/set-pinned')
  @ApiOperation({ summary: 'Pin / unpin a conversation (pinned-first ordering)' })
  async setPinned(@Request() req, @Body() dto: SetPinnedDto): Promise<ApiResult> {
    const updated = await this.participantService.setPinned(
      req.user.userId,
      dto.threadId,
      dto.pinned,
    );
    // Carry the resulting pinnedAt so other devices sort the row into the pinned tier correctly
    // (pinning stamps now(); unpinning clears it).
    this.sseService.onThreadMeta(
      req.user.userId,
      serializeBody({
        event: 'THREAD_META',
        threadId: dto.threadId,
        pinned: dto.pinned,
        pinnedAt: updated.pinnedAt,
      }),
    );
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard, ThreadAccessGuard)
  @ResourceId<ClearHistoryDto>('threadId')
  @Throttle(10, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/clear-history')
  @ApiOperation({
    summary: 'Clear chat history for me (hides all messages up to now; peer copy untouched)',
  })
  async clearHistory(@Request() req, @Body() dto: ClearHistoryDto): Promise<ApiResult> {
    const updated = await this.participantService.clearHistory(
      req.user.userId,
      dto.threadId,
    );
    this.sseService.onThreadMeta(
      req.user.userId,
      serializeBody({ event: 'THREAD_META', threadId: dto.threadId, clearedAt: updated.clearedAt }),
    );
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SetAliasDto>('threadId')
  @Throttle(30, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/set-alias')
  @ApiOperation({
    summary: 'Set a per-user alias/remark (备注) for a conversation (overrides the displayed name for the caller)',
  })
  async setAlias(@Request() req, @Body() dto: SetAliasDto): Promise<ApiResult> {
    const updated = await this.participantService.setAlias(
      req.user.userId,
      dto.threadId,
      dto.alias,
    );
    // Carry the resolved alias (null when cleared) so other devices flip their header/list title live.
    this.sseService.onThreadMeta(
      req.user.userId,
      serializeBody({ event: 'THREAD_META', threadId: dto.threadId, alias: updated.alias }),
    );
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SearchMessagesDto>('threadId')
  @Throttle(30, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('search-messages')
  @ApiOperation({
    summary: 'Search a conversation by substring (returns lightweight match ids for kernel jump)',
  })
  async searchMessages(@Body() dto: SearchMessagesDto): Promise<ApiResult> {
    // Membership is resolved by ThreadAccessGuard (THREAD_NOT_FOUND for non-participants). The match
    // list excludes blocked/muted indirectly: blocked creators' messages are already hidden at the
    // source by the send fan-out, and clearedAt only affects the user's own view — search returns the
    // raw id matches; the client jumps the kernel, which loads each via query-messages (re-applying
    // clearedAt/block). take+1 hasMore trick.
    const lastId = dto.lastId !== undefined ? BigInt(dto.lastId) : undefined;
    const rows = await this.messageService.searchMessages(
      dto.threadId,
      dto.keyword,
      dto.take,
      lastId,
    );
    const hasMore = rows.length > dto.take;
    const data = hasMore ? rows.slice(0, dto.take) : rows;
    return { code: BusinessCode.OK, message: 'successful', data, hasMore };
  }
}
