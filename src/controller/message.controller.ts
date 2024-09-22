import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards
} from '@nestjs/common';
import { UserService } from '../user/user.service';
import { MessageService } from '../message/message.service';
import { ContentType, MessageThreadType, Prisma } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { toJson, StandardResponse } from './utils';

@Controller()
export class MessageController {
  constructor(
    private readonly userService: UserService,
    private readonly messageService: MessageService
  ) { }

  @UseGuards(JwtAuthGuard)
  @Post('send-message')
  async sendMessage(@Request() req,
    @Body() params: { threadId: number, content: string },
  ) {
    if (!params.content) {
      return
    }
    const list = await this.messageService.sendMessageToThread(req.user.userId, params.threadId, params.content, ContentType.PURE_TEXT)
    return toJson(list)
  }

  @UseGuards(JwtAuthGuard)
  @Post('query-messages')
  async queryMessages(@Request() req,
    @Body() params: {
      threadId: number,
      skip: number;
      take: number;
      lastId?: number;
      orderBy: 'desc' | 'asc'
    },
  ) {
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
    const list = await this.messageService.queryMessages(req.user.userId, params.threadId, newParams)
    return toJson(list)
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