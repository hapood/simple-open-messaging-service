import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards
} from '@nestjs/common';
import { MessageService } from '../message/message.service';
import { ContentType, MessageThreadType, Prisma, UserMessageThreadStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { toJson, StandardResponse } from './utils';
import { EventGateway } from 'src/gateway/event.gateway';
import { GroupService } from 'src/group/group.service';

@Controller()
export class MessageController {
  constructor(
    private readonly messageService: MessageService,
    private readonly eventGateway: EventGateway,
    private readonly groupService: GroupService
  ) { }

  @UseGuards(JwtAuthGuard)
  @Post('send-message')
  async sendMessage(@Request() req,
    @Body() params: { userThreadId: number, content: string },
  ): Promise<StandardResponse> {
    if (!params.content?.trim()) {
      return { status: 2, message: 'no content' }
    }
    const userMsgTr = await this.messageService.findUniqueUserMessageThread({
      id: params.userThreadId
    })
    if (userMsgTr.toObjType === MessageThreadType.GROUP_MESSAGE) {
      if (userMsgTr.status === UserMessageThreadStatus.APPROVED) {
        const data = await this.messageService.writeMsgToThread(req.user.userId, userMsgTr.threadId, params.content, ContentType.PURE_TEXT)
        const userIds = await this.groupService.getAllGroupUserIds(userMsgTr.toObjId)
        userIds.forEach(userId => {
          this.eventGateway.onNewMessage(userMsgTr.toObjId, userMsgTr.threadId)
        })
        return { status: 0, message: 'sucessful', data: toJson(data) }
      }
    } else {
      const friendMsgTr = await this.messageService.findUniqueUserMessageThread({
        userId_threadId: {
          userId: userMsgTr.toObjId,
          threadId: userMsgTr.threadId
        }
      })
      if (friendMsgTr.status === UserMessageThreadStatus.APPROVED && userMsgTr.status === UserMessageThreadStatus.APPROVED) {
        const data = await this.messageService.writeMsgToThread(req.user.userId, userMsgTr.threadId, params.content, ContentType.PURE_TEXT)
        this.eventGateway.onNewMessage(req.user.userId, userMsgTr.threadId)
        this.eventGateway.onNewMessage(userMsgTr.toObjId, userMsgTr.threadId)
        return { status: 0, message: 'sucessful', data: toJson(data) }
      }
    }
    return {
      status: 1,
      message: 'failed'
    }
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
  ): Promise<StandardResponse> {
    const userThread = await this.messageService.findUniqueUserMessageThread({
      id: params.userThreadId
    })
    if (userThread.status === UserMessageThreadStatus.APPROVED) {
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
      const data = await this.messageService.queryMessages(userThread.threadId, newParams)
      return {
        status: 0, message: 'sucessful', data: toJson(data)
      }
    } else {
      return { status: 2, message: `no user thread $[${params.userThreadId}]` }
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('thread/by-user-id')
  async getThreadByUniqName(@Request() req, @Body() params: { userId: number }): Promise<StandardResponse> {
    const userId = req.user.userId
    const thread = await this.messageService.findUniqueUserMessageThread({
      userId_toObjType_toObjId: {
        userId,
        toObjType: MessageThreadType.P2P_MESSAGE,
        toObjId: params.userId
      }
    })
    if (thread === null) {
      return {
        status: 1,
        message: `no thread with user [${params.userId}]`,
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