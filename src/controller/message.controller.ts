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
import { serializeBody } from '../common/serialize.interceptor.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { ThreadAccessGuard } from '../thread-participant/thread-access.guard.js';
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
  ) {}

  @UseGuards(JwtAuthGuard, ThrottleGuard, ThreadAccessGuard)
  @Throttle(60, 60) // anti-spam ceiling: 60 sends/min
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('send-message')
  @ApiOperation({ summary: '发送消息（P2P/群统一）' })
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
    // WS 推完整消息体（serializeBody 把 BigInt→string / Date→ms，与 HTTP 响应同口径；
    // 前端收到即可直接渲染，无需二次 query-messages）。
    const msgData = serializeBody({ threadId: dto.threadId, ...data });
    // Unified fan-out: every active participant of the thread (P2P = both sides, GROUP = all members).
    const userIds = await this.participantService.getActiveParticipantUserIds(
      dto.threadId,
    );
    userIds.forEach((item) => {
      this.sseService.onNewMessage(item.userId, msgData);
    });
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  @UseGuards(JwtAuthGuard, ThreadAccessGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('query-messages')
  @ApiOperation({ summary: '查询会话历史消息（游标分页）' })
  @ApiResultResponse(MessageResponseDto, true)
  async queryMessages(
    @Request() req,
    @Body() dto: QueryMessagesDto,
  ): Promise<ApiResult> {
    // Membership is resolved by ThreadAccessGuard (THREAD_NOT_FOUND for non-participants) — the same
    // IDOR fix as send, now declarative. The participant row is on req.threadAccess.participant.
    // take+1 法：多取 1 条判断 hasMore，data 截断回 take 条。
    // 消除「总数恰为 take 整数倍时前端靠 <take 启发式多打一次空请求」的边界问题。
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
  @ApiOperation({ summary: '按对端 userId 查 P2P 关系（好友状态/会话）' })
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
