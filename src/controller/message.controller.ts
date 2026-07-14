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
import { MessageService } from '../message/message.service.js';
import { ContentType, Prisma } from '../prisma/generated/client.js';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { ApiResult, ApiResultResponse } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { MessageResponseDto } from '../dto/response.dto.js';
import { UserIdDto } from '../dto/user.dto.js';
import { SseService } from '../gateway/sse.service.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { ThreadAccessGuard } from '../thread-participant/thread-access.guard.js';
import { ResourceId } from '../common/resource-id.decorator.js';
import {
  parseAudioContent,
  parseFileContent,
  parseVideoContent,
} from '../upload/file-content.js';
import { UserBlockService } from '../user-block/user-block.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { FederationService } from '../federation/federation.service.js';
import { QuotaService } from '../quota/quota.service.js';
import {
  SendMessageDto,
  SendMediaDto,
  QueryMessagesDto,
  MarkReadDto,
  MediaStatusDto,
  RelocalizeMediaDto,
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
    private readonly userBlockService: UserBlockService,
    private readonly fanout: MessageFanoutService,
    private readonly quota: QuotaService,
    private readonly federation: FederationService,
  ) {}

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SendMessageDto>('threadId')
  @Throttle(60, 60) // anti-spam ceiling: 60 sends/min
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('send-message')
  @ApiOperation({ summary: 'Send a message (unified for P2P and group)' })
  @ApiResultResponse(MessageResponseDto)
  async sendMessage(
    @Request() req: FastifyRequest,
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
    // Daily quota (local aggregate budget — one bucket shared by all local users). A TEXT send consumes
    // one 'messages' unit; media contentTypes (IMAGE/FILE/VIDEO/AUDIO) are counted at their /upload*
    // step (images / largeFiles), not here, so a media message is never double-counted.
    if (contentType === ContentType.PURE_TEXT) {
      const q = await this.quota.tryTickLocal('messages');
      if (q.exceeded) {
        return {
          code: BusinessCode.QUOTA_EXCEEDED,
          message: `daily message quota reached (${q.limit}); resets in ${q.retryAfter}s`,
          data: { category: 'messages', limit: q.limit, retryAfter: q.retryAfter },
        };
      }
    }
    const data = await this.messageService.writeMsgToThread(
      req.user.userId,
      dto.threadId,
      dto.content,
      contentType,
      dto.clientMessageId,
    );
    // Fire-and-forget: the response confirms PERSISTENCE (the row is committed above); recipient
    // fan-out (SSE + push + notif + federation hint) runs off the request critical path. The client
    // reconciles by seq/id, so an SSE frame landing after the 200 is harmless. The staged-media promote
    // path uses the same dispatch, so text and media fan out identically.
    void this.fanout.dispatch(data);
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  /**
   * Stage a media message BEFORE its file is uploaded. Creates a PendingMedia(pending) row keyed by
   * clientMessageId (carrying any client-probed display meta) — durable intent recorded BEFORE the file
   * write, so a crash between staging and upload leaves an attributable record, never the unattributed
   * orphan the old upload-then-send order produced. No Message or seq is created; nothing is fanned
   * out. The client follows this with POST /upload* (carrying the same clientMessageId) which writes
   * the file and promotes the stage to a real Message (the promote path runs the fan-out).
   *
   * Membership is resolved by ThreadAccessGuard (THREAD_NOT_FOUND for non-participants), same as text.
   * Idempotent: a retried stage with the same clientMessageId returns the existing stage.
   */
  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SendMediaDto>('threadId')
  @Throttle(60, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('send-media')
  @ApiOperation({ summary: 'Stage a media message (before upload); promoted on POST /upload*' })
  @ApiResultResponse(MessageResponseDto)
  async sendMedia(@Request() req: FastifyRequest, @Body() dto: SendMediaDto): Promise<ApiResult> {
    const meta: Record<string, unknown> = {};
    if (dto.meta?.w !== undefined) meta.w = dto.meta.w;
    if (dto.meta?.h !== undefined) meta.h = dto.meta.h;
    if (dto.meta?.duration !== undefined) meta.duration = dto.meta.duration;
    await this.messageService.stageMedia(
      req.user.userId,
      dto.threadId,
      dto.contentType,
      dto.clientMessageId,
      meta,
    );
    return { code: BusinessCode.OK, message: 'successful', data: { clientMessageId: dto.clientMessageId } };
  }

  @UseGuards(ThreadAccessGuard)
  @ResourceId<QueryMessagesDto>('threadId')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('query-messages')
  @ApiOperation({
    summary: 'Query conversation history messages (cursor pagination)',
  })
  @ApiResultResponse(MessageResponseDto, true)
  async queryMessages(
    @Request() req: FastifyRequest,
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
      orderBy: { seq: dto.orderBy },
    };
    if (dto.lastSeq) {
      // seq is unique only within a thread, so the keyset cursor uses the compound (threadId, seq) unique.
      newParams.cursor = {
        threadId_seq: { threadId: dto.threadId, seq: Number(dto.lastSeq) },
      };
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

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/by-user-id')
  @ApiOperation({
    summary: 'Look up the P2P thread by peer userId (friends only)',
  })
  async getThreadByUserId(
    @Request() req: FastifyRequest,
    @Body() dto: UserIdDto,
  ): Promise<ApiResult> {
    // A friend relationship == an active P2P thread shared by both. No thread → THREAD_NOT_FOUND,
    // deliberately non-leaking (a caller cannot probe a pending invite or prior relationship), the
    // same policy ThreadAccessGuard enforces.
    const threadId = await this.participantService.findP2PThreadBetween(
      req.user.userId,
      dto.userId,
    );
    if (threadId === null) {
      return {
        code: BusinessCode.THREAD_NOT_FOUND,
        message: `no relationship with user [${dto.userId}]`,
      };
    }
    return { code: BusinessCode.OK, message: 'successful', data: { threadId } };
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<MarkReadDto>('threadId')
  @Throttle(60, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/mark-read')
  @ApiOperation({
    summary: 'Mark a conversation read (advances the per-user read cursor)',
  })
  async markRead(@Request() req: FastifyRequest, @Body() dto: MarkReadDto): Promise<ApiResult> {
    // Membership is resolved by ThreadAccessGuard (THREAD_NOT_FOUND for non-participants); the
    // participant row is on req.threadAccess.participant.
    // Resolve the cursor to advance to. With an explicit id, validate it belongs to this thread
    // (prevents pointing the cursor at a message from another conversation). Without one, mark all
    // current messages read by using the thread's denormalized lastMessageSeq. The numeric-string
    // shape of lastReadMessageId is enforced by MarkReadDto's @Matches.
    let cursor: number;
    if (dto.lastReadSeq !== undefined) {
      const msg = await this.messageService.findMessageBySeq(
        dto.threadId,
        Number(dto.lastReadSeq),
      );
      // findMessageBySeq is scoped by (threadId, seq), so null means no such message in THIS thread.
      if (msg === null) {
        return {
          code: BusinessCode.NOT_FOUND,
          message: `no such message in thread [${dto.threadId}]`,
        };
      }
      cursor = msg.seq;
    } else {
      const thread = await this.messageService.findThread(dto.threadId);
      const last = thread?.lastMessageSeq ?? null;
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
        serializeBody({ threadId: dto.threadId, lastReadSeq: cursor }),
      );
    }
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SetMutedDto>('threadId')
  @Throttle(30, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/set-muted')
  @ApiOperation({
    summary:
      'Mute / unmute a conversation (suppresses notifications, not delivery)',
  })
  async setMuted(@Request() req: FastifyRequest, @Body() dto: SetMutedDto): Promise<ApiResult> {
    await this.participantService.setMuted(
      req.user.userId,
      dto.threadId,
      dto.muted,
    );
    // Sync the caller's other online devices so their list row swaps the mute icon live (no reload).
    this.sseService.onThreadMeta(
      req.user.userId,
      serializeBody({
        event: 'THREAD_META',
        threadId: dto.threadId,
        muted: dto.muted,
      }),
    );
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SetPinnedDto>('threadId')
  @Throttle(30, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/set-pinned')
  @ApiOperation({
    summary: 'Pin / unpin a conversation (pinned-first ordering)',
  })
  async setPinned(
    @Request() req: FastifyRequest,
    @Body() dto: SetPinnedDto,
  ): Promise<ApiResult> {
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

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<ClearHistoryDto>('threadId')
  @Throttle(10, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/clear-history')
  @ApiOperation({
    summary:
      'Clear chat history for me (hides all messages up to now; peer copy untouched)',
  })
  async clearHistory(
    @Request() req: FastifyRequest,
    @Body() dto: ClearHistoryDto,
  ): Promise<ApiResult> {
    const updated = await this.participantService.clearHistory(
      req.user.userId,
      dto.threadId,
    );
    this.sseService.onThreadMeta(
      req.user.userId,
      serializeBody({
        event: 'THREAD_META',
        threadId: dto.threadId,
        clearedAt: updated.clearedAt,
      }),
    );
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SetAliasDto>('threadId')
  @Throttle(30, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/set-alias')
  @ApiOperation({
    summary:
      'Set a per-user alias/remark for a conversation (overrides the displayed name for the caller)',
  })
  async setAlias(@Request() req: FastifyRequest, @Body() dto: SetAliasDto): Promise<ApiResult> {
    const updated = await this.participantService.setAlias(
      req.user.userId,
      dto.threadId,
      dto.alias,
    );
    // Carry the resolved alias (null when cleared) so other devices flip their header/list title live.
    this.sseService.onThreadMeta(
      req.user.userId,
      serializeBody({
        event: 'THREAD_META',
        threadId: dto.threadId,
        alias: updated.alias,
      }),
    );
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SearchMessagesDto>('threadId')
  @Throttle(30, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('search-messages')
  @ApiOperation({
    summary:
      'Search a conversation by substring (returns lightweight match ids for kernel jump)',
  })
  async searchMessages(@Body() dto: SearchMessagesDto): Promise<ApiResult> {
    // Membership is resolved by ThreadAccessGuard (THREAD_NOT_FOUND for non-participants). The match
    // list excludes blocked/muted indirectly: blocked creators' messages are already hidden at the
    // source by the send fan-out, and clearedAt only affects the user's own view — search returns the
    // raw id matches; the client jumps the kernel, which loads each via query-messages (re-applying
    // clearedAt/block). take+1 hasMore trick.
    const lastSeq = dto.lastSeq !== undefined ? Number(dto.lastSeq) : undefined;
    const rows = await this.messageService.searchMessages(
      dto.threadId,
      dto.keyword,
      dto.take,
      lastSeq,
    );
    const hasMore = rows.length > dto.take;
    const data = hasMore ? rows.slice(0, dto.take) : rows;
    return { code: BusinessCode.OK, message: 'successful', data, hasMore };
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<RelocalizeMediaDto>('threadId')
  @Throttle(10, 60) // retry ceiling: 10 re-localize attempts/min (each is a peer fetch when not cached)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('relocalize-media')
  @ApiOperation({
    summary:
      'Manually re-run federated media localize for one message (retry after a localize failure)',
  })
  async relocalizeMedia(
    @Request() req: FastifyRequest,
    @Body() dto: RelocalizeMediaDto,
  ): Promise<ApiResult> {
    // ThreadAccessGuard resolved membership + scoped threadId; localizeMediaForMessage re-validates
    // (threadId, seq) exists and re-runs the idempotent localize path. localizeMedia pushes the terminal
    // MEDIA_STATUS itself, so this returns the outcome for the caller's optimistic flip.
    const status = await this.federation.localizeMediaForMessage(
      req.threadAccess.threadId,
      dto.seq,
    );
    return { code: BusinessCode.OK, message: 'successful', data: { status } };
  }

  @UseGuards(ThreadAccessGuard)
  @ResourceId<MediaStatusDto>('threadId')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('media-status')
  @ApiOperation({
    summary:
      'Bulk-probe federated media localize status (scroll backstop for missed MEDIA_STATUS frames)',
  })
  async mediaStatus(@Body() dto: MediaStatusDto): Promise<ApiResult> {
    // No ThrottleGuard: a cheap read (two batched queries), fired only on scroll when the viewport
    // exposes non-ready media. ThreadAccessGuard scopes threadId; missing seqs are omitted.
    const statuses = await this.messageService.queryMediaStatus(
      dto.threadId,
      dto.seqs,
    );
    return { code: BusinessCode.OK, message: 'successful', data: { statuses } };
  }
}
