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
import {
  ContentType,
  MessageThreadType,
  Prisma,
  UserMessageThreadStatus,
} from '../prisma/generated/client.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ApiResult, ApiResultResponse } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import {
  MessageResponseDto,
  UserMessageThreadResponseDto,
} from '../dto/response.dto.js';
import { SendMessageDto, QueryMessagesDto } from '../dto/message.dto.js';
import { UserIdDto } from '../dto/user.dto.js';
import { SseService } from '../gateway/sse.service.js';
import { GroupService } from '../group/group.service.js';
import { serializeBody } from '../common/serialize.interceptor.js';

@ApiTags('message')
@Controller()
export class MessageController {
  constructor(
    private readonly messageService: MessageService,
    private readonly sseService: SseService,
    private readonly groupService: GroupService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('send-message')
  @ApiOperation({ summary: '发送消息（P2P/群）' })
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
    const userMsgTr = await this.messageService.findUniqueUserMessageThread({
      where: { id: dto.userThreadId },
    });
    // B1：记录不存在时直接返回业务码，避免下方 .toObjType 抛 TypeError → 500
    if (userMsgTr === null) {
      return {
        code: BusinessCode.THREAD_NOT_FOUND,
        message: `no user thread [${dto.userThreadId}]`,
      };
    }
    if (userMsgTr.toObjType === MessageThreadType.GROUP) {
      if (userMsgTr.status === UserMessageThreadStatus.APPROVED) {
        const data = await this.messageService.writeMsgToThread(
          req.user.userId,
          userMsgTr.threadId,
          dto.content,
          dto.contentType ?? ContentType.PURE_TEXT,
        );
        // WS 推完整消息体（serializeBody 把 BigInt→string / Date→ms，与 HTTP 响应同口径；
        // 前端收到即可直接渲染，无需二次 query-messages）。
        const msgData = serializeBody({
          threadId: userMsgTr.threadId,
          ...data,
        });
        const userIds = await this.groupService.getAllGroupUserIds(
          userMsgTr.toObjId,
        );
        userIds.forEach((item) => {
          this.sseService.onNewMessage(item.userId, msgData);
        });
        return { code: BusinessCode.OK, message: 'successful', data };
      }
    } else {
      const friendMsgTr = await this.messageService.findUniqueUserMessageThread(
        {
          where: {
            userId_threadId: {
              userId: userMsgTr.toObjId,
              threadId: userMsgTr.threadId,
            },
          },
        },
      );
      if (
        friendMsgTr.status === UserMessageThreadStatus.APPROVED &&
        userMsgTr.status === UserMessageThreadStatus.APPROVED
      ) {
        const data = await this.messageService.writeMsgToThread(
          req.user.userId,
          userMsgTr.threadId,
          dto.content,
          dto.contentType ?? ContentType.PURE_TEXT,
        );
        const msgData = serializeBody({
          threadId: userMsgTr.threadId,
          ...data,
        });
        this.sseService.onNewMessage(req.user.userId, msgData);
        this.sseService.onNewMessage(userMsgTr.toObjId, msgData);
        return { code: BusinessCode.OK, message: 'successful', data };
      }
    }
    return {
      code: BusinessCode.THREAD_NOT_APPROVED,
      message: 'failed',
    };
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
    const userThread = await this.messageService.findUniqueUserMessageThread({
      where: { id: dto.userThreadId },
    });
    // B1：记录不存在时直接返回业务码，避免下方 .status 抛 TypeError → 500
    if (userThread === null) {
      return {
        code: BusinessCode.THREAD_NOT_FOUND,
        message: `no user thread [${dto.userThreadId}]`,
      };
    }
    if (userThread.status === UserMessageThreadStatus.APPROVED) {
      // take+1 法：多取 1 条判断 hasMore，data 截断回 take 条。
      // 消除「总数恰为 take 整数倍时前端靠 <take 启发式多打一次空请求」的边界问题。
      const newParams: Prisma.MessageFindManyArgs = {
        skip: dto.skip,
        take: dto.take + 1,
        orderBy: {
          id: dto.orderBy,
        },
      };
      if (dto.lastId) {
        newParams.cursor = { id: BigInt(dto.lastId) };
      }
      const rows = await this.messageService.queryMessages(
        userThread.threadId,
        newParams,
      );
      const hasMore = rows.length > dto.take;
      const data = hasMore ? rows.slice(0, dto.take) : rows;
      return {
        code: BusinessCode.OK,
        message: 'successful',
        data,
        hasMore,
      };
    } else {
      return { code: BusinessCode.THREAD_NOT_FOUND, message: `no user thread $[${dto.userThreadId}]` };
    }
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/by-user-id')
  @ApiOperation({ summary: '按对端 userId 查 P2P 会话' })
  @ApiResultResponse(UserMessageThreadResponseDto)
  async getThreadByUniqName(
    @Request() req,
    @Body() dto: UserIdDto,
  ): Promise<ApiResult> {
    const userId = req.user.userId;
    const thread = await this.messageService.findUniqueUserMessageThread({
      where: {
        userId_toObjType_toObjId: {
          userId,
          toObjType: MessageThreadType.P2P,
          toObjId: dto.userId,
        },
      },
    });
    if (thread === null) {
      return {
        code: BusinessCode.THREAD_NOT_FOUND,
        message: `no thread with user [${dto.userId}]`,
      };
    } else {
      return {
        code: BusinessCode.OK,
        message: 'successful',
        data: thread,
      };
    }
  }
}
