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
import { SendMessageDto, QueryMessagesDto } from '../dto/message.dto.js';
import { UserIdDto } from '../dto/user.dto.js';
import { SseService } from '../gateway/sse.service.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { FriendshipService } from '../friendship/friendship.service.js';

@ApiTags('message')
@Controller()
export class MessageController {
  constructor(
    private readonly messageService: MessageService,
    private readonly sseService: SseService,
    private readonly participantService: ThreadParticipantService,
    private readonly friendshipService: FriendshipService,
  ) {}

  @UseGuards(JwtAuthGuard, ThrottleGuard)
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
    // content 缺失/空串已由 SendMessageDto 的 @IsNotEmpty 拦截 → ValidationPipe 纳入业务流(200/10000)；
    // 这里仅处理纯空白（业务码 MESSAGE_EMPTY）。
    if (!dto.content?.trim()) {
      return { code: BusinessCode.MESSAGE_EMPTY, message: 'no content' };
    }
    // Authorization (fixes the former IDOR): the caller must be an ACTIVE participant of the thread.
    // P2P and GROUP share one check. Returns NOT_FOUND to avoid leaking thread existence to non-members.
    const me = await this.participantService.findActiveParticipant(
      req.user.userId,
      dto.threadId,
    );
    if (me === null) {
      return {
        code: BusinessCode.THREAD_NOT_FOUND,
        message: `no thread [${dto.threadId}]`,
      };
    }
    const data = await this.messageService.writeMsgToThread(
      req.user.userId,
      dto.threadId,
      dto.content,
      dto.contentType ?? ContentType.PURE_TEXT,
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

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('query-messages')
  @ApiOperation({ summary: '查询会话历史消息（游标分页）' })
  @ApiResultResponse(MessageResponseDto, true)
  async queryMessages(
    @Request() req,
    @Body() dto: QueryMessagesDto,
  ): Promise<ApiResult> {
    // Authorization: active participant only (fixes the former IDOR on history reads).
    const me = await this.participantService.findActiveParticipant(
      req.user.userId,
      dto.threadId,
    );
    if (me === null) {
      return {
        code: BusinessCode.THREAD_NOT_FOUND,
        message: `no thread [${dto.threadId}]`,
      };
    }
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
    const { friendship } = await this.friendshipService.getFriendship(
      req.user.userId,
      dto.userId,
    );
    if (friendship === null) {
      return {
        code: BusinessCode.THREAD_NOT_FOUND,
        message: `no relationship with user [${dto.userId}]`,
      };
    }
    return { code: BusinessCode.OK, message: 'successful', data: friendship };
  }
}
