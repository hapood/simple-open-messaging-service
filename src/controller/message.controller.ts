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
import {
  SendMessageDto,
  QueryMessagesDto,
  MarkReadDto,
} from '../dto/message.dto.js';
import { UserIdDto } from '../dto/user.dto.js';
import { SseService } from '../gateway/sse.service.js';
import { PushService } from '../push/push.service.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { ThreadAccessGuard } from '../thread-participant/thread-access.guard.js';
import { ResourceId } from '../common/resource-id.decorator.js';
import { FriendshipService } from '../friendship/friendship.service.js';
import { parseFileContent } from '../upload/file-content.js';

@ApiTags('message')
@Controller()
export class MessageController {
  constructor(
    private readonly messageService: MessageService,
    private readonly sseService: SseService,
    private readonly participantService: ThreadParticipantService,
    private readonly friendshipService: FriendshipService,
    private readonly pushService: PushService,
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
    // FILE content is a server-trust contract: the client only forwards what POST /upload/file
    // returned. parseFileContent rejects any non-upload URL, disallowed mimetype, or bad shape so a
    // forged `javascript:`/external/traversal URL or oversized value can never be stored (and later
    // rendered into a download link). PURE_TEXT/IMAGE keep their existing verbatim storage.
    if (contentType === ContentType.FILE && !parseFileContent(dto.content)) {
      return {
        code: BusinessCode.VALIDATION_FAILED,
        message: 'invalid file content',
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
    const userIds = await this.participantService.getActiveParticipantUserIds(
      dto.threadId,
    );
    userIds.forEach((item) => {
      this.sseService.onNewMessage(item.userId, msgData);
    });
    // FCM wake-up for OFFLINE recipients (PushService filters out the sender and anyone with a live SSE
    // connection). Fire-and-forget — push latency must not delay this HTTP response, and dispatchForMessage
    // swallows all errors so a push failure can never break message delivery.
    void this.pushService.dispatchForMessage(
      userIds,
      req.user.userId,
      dto.threadId,
      msgData,
    );
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
    const rows = await this.messageService.queryMessages(
      dto.threadId,
      newParams,
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
}
