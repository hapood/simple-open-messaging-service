import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards
} from '@nestjs/common';
import { MessageService } from '../message/message.service';
import { ContentType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StandardResponse } from './utils';
import dayjs from 'dayjs';
import { GroupService } from 'src/group/group.service';

@Controller()
export class MessageController {
  constructor(
    private readonly messageService: MessageService,
    private readonly groupService: GroupService
  ) { }

  @UseGuards(JwtAuthGuard)
  @Post('group/create')
  async createNewGroup(@Request() req, @Body() params: { groupName: string }): Promise<StandardResponse> {
    const userId = req.user.userId
    if (params.groupName.length > 31) {
      return {
        status: 1,
        message: `group name must less than 32 characters`
      }
    }
    const trd = await this.groupService.createNewGroup({
      owner: userId,
      groupName: params.groupName
    })
    return {
      status: 0,
      message: 'successful',
      data: { threadId: trd.id, groupId: trd.groupId }
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('group/invite-user')
  async inviteUsers(@Request() req, @Body() params: { userId: number, threadId: number }): Promise<StandardResponse> {
    const groupTrd = await this.messageService.findUniqueUserMessageThread({ userId_threadId: { userId: req.user.userId, threadId: params.threadId } })
    if (groupTrd !== null) {
      const { isFriend, userMsgTr } = await this.messageService.getFriendship({ userId: req.user.userId, friendUserId: params.userId })
      if (isFriend) {
        const expiryDate = dayjs().add(3, 'day').valueOf()
        this.messageService.writeMsgToThread(req.user.userId, groupTrd.threadId, JSON.stringify({
          type: 'GROUP_INVITE',
          inviter: req.user.userId,
          expiryDate,
          key: this.groupService.generateInviteToken({
            toUserId: userMsgTr.toObjId,
            threadId: userMsgTr.threadId,
            expiryDate
          })
        }), ContentType.CARD)
        return {
          status: 0,
          message: 'successful'
        }
      } else {
        return {
          status: 1,
          message: `[${params.userId}] is not your feiend`
        }
      }
    } else {
      return {
        status: 2,
        message: `you are not in group [${params.userId}]`
      }
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('group/join')
  async joinGroup(@Request() req, @Body() params: { token: string }): Promise<StandardResponse> {
    const res = this.groupService.decodeInviteDate(params)
    if (res.status === 0) {
      const data = res.data
      await this.groupService.joinGroup({ threadId: data.tid, userId: data.sub })
      return {
        status: 0,
        message: 'succesful'
      }
    } else if (res.status === 1) {
      return {
        status: 1,
        message: 'invalid invite'
      }
    } else if (res.status === 1) {
      return {
        status: 1,
        message: 'invite expired'
      }
    }
  }
}