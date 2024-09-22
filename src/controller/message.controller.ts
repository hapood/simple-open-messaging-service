import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards
} from '@nestjs/common';
import { UserService } from '../user/user.service';
import { MessageService } from '../message/message.service';
import { ContentType, MessageThreadType, Prisma, UserMessageThreadStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { toJson, StandardResponse } from './utils';
import { EventGateway } from 'src/gateway/event.gateway';
@Controller()
export class MessageController {
  constructor(
    private readonly userService: UserService,
    private readonly messageService: MessageService,
    private readonly eventGateway: EventGateway
  ) { }

  @UseGuards(JwtAuthGuard)
  @Post('send-message')
  async sendMessage(@Request() req,
    @Body() params: { threadId: number, content: string },
  ) {
    if (!params.content) {
      return
    }
    const data = await this.messageService.sendMessageToThread(req.user.userId, params.threadId, params.content, ContentType.PURE_TEXT)
    this.messageService.findUniqueUserMessageThread({
      userId_threadId: {
        userId: req.user.userId, threadId: params.threadId
      }
    }).then(thread => {
      this.eventGateway.onNewMessage(req.user.userId, thread.id)
      this.eventGateway.onNewMessage(thread.toObjId, thread.id)
    })
    return toJson(data)
  }

  @UseGuards(JwtAuthGuard)
  @Post('query-messages')
  async queryMessages(@Request() req,
    @Body() params: {
      userThreadId: number,
      skip: number;
      take: number;
      lastId?: number;
      orderBy: 'desc' | 'asc'
    },
  ) {
    const userThread = await this.messageService.findUniqueUserMessageThread({
      id: params.userThreadId
    })
    if (userThread.status !== UserMessageThreadStatus.DELETED) {
      const newParams: Prisma.MessageFindManyArgs = {
        skip: params.skip,
        take: params.take,
        orderBy: {
          id: params.orderBy,
        },
      };
      if (params.lastId) {
        newParams.cursor = { id: params.lastId }
      }
      const data = await this.messageService.queryMessages(req.user.userId, userThread.threadId, newParams)
      return data
    } else {
      return { status: 2, message: `no user thread $[${params.userThreadId}]` }
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('thread/by-user-id')
  async getThreadByUniqName(@Request() req, @Body() { userId: toUserId }: { userId: number }): Promise<StandardResponse> {
    const userId = req.user.userId
    const thread = await this.messageService.findUniqueUserMessageThread({
      userId_toObjType_toObjId: {
        userId,
        toObjType: MessageThreadType.P2P_MESSAGE,
        toObjId: toUserId
      }
    })
    if (thread === null) {
      return {
        status: 1,
        message: `no thread with user [${toUserId}]`,
      }
    } else {
      return {
        status: 0,
        message: 'successful',
        data: thread
      }
    }
  }
}