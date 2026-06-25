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
import { MessageService } from '../message/message.service';
import {
  ContentType,
  MessageThreadType,
  Prisma,
  UserMessageThreadStatus,
} from '../prisma/generated/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ApiResult, ApiResultResponse } from '../common/api-result';
import { BusinessCode } from '../common/business-code';
import {
  MessageResponseDto,
  UserMessageThreadResponseDto,
} from '../dto/response.dto';
import { SendMessageDto, QueryMessagesDto } from '../dto/message.dto';
import { UserIdDto } from '../dto/user.dto';
import { EventGateway } from 'src/gateway/event.gateway';
import { GroupService } from 'src/group/group.service';

@ApiTags('message')
@Controller()
export class MessageController {
  constructor(
    private readonly messageService: MessageService,
    private readonly eventGateway: EventGateway,
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
      where: {
        id: dto.userThreadId,
      },
    });
    if (userMsgTr.toObjType === MessageThreadType.GROUP) {
      if (userMsgTr.status === UserMessageThreadStatus.APPROVED) {
        const data = await this.messageService.writeMsgToThread(
          req.user.userId,
          userMsgTr.threadId,
          dto.content,
          ContentType.PURE_TEXT,
        );
        const msgData = {
          threadId: userMsgTr.threadId,
          msgId: data.id.toString(),
        };
        const userIds = await this.groupService.getAllGroupUserIds(
          userMsgTr.toObjId,
        );
        userIds.forEach((item) => {
          this.eventGateway.onNewMessage(item.userId, msgData);
        });
        return { code: BusinessCode.OK, message: 'sucessful', data };
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
          ContentType.PURE_TEXT,
        );
        const msgData = {
          threadId: userMsgTr.threadId,
          msgId: data.id.toString(),
        };
        this.eventGateway.onNewMessage(req.user.userId, msgData);
        this.eventGateway.onNewMessage(userMsgTr.toObjId, msgData);
        return { code: BusinessCode.OK, message: 'sucessful', data };
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
      where: {
        id: dto.userThreadId,
      },
    });
    if (userThread.status === UserMessageThreadStatus.APPROVED) {
      const newParams: Prisma.MessageFindManyArgs = {
        skip: dto.skip,
        take: dto.take,
        orderBy: {
          id: dto.orderBy,
        },
      };
      if (dto.lastId) {
        newParams.cursor = { id: BigInt(dto.lastId) };
      }
      const data = await this.messageService.queryMessages(
        userThread.threadId,
        newParams,
      );
      return {
        code: BusinessCode.OK,
        message: 'sucessful',
        data,
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
