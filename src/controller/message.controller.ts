import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards
} from '@nestjs/common';
import { UserService } from '../user/user.service';
import { MessageService } from '../message/message.service';
import { User as UserModel, ContentType, Prisma, UserMessageThread } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { toJson } from './utils';

@Controller()
export class MessageController {
  constructor(
    private readonly userService: UserService,
    private readonly messageService: MessageService
  ) { }


  @UseGuards(JwtAuthGuard)
  @Post('query-thread-info')
  async queryThreadInfo(
    @Request() req,
    @Body() params: { threadId: number },
  ): Promise<UserMessageThread> {
    return await this.messageService.findUniqueUserThread({ userId_threadId: { userId: req.user.userId, threadId: params.threadId } })
  }

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

}