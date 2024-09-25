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
import * as dayjs from 'dayjs';
import { GroupService } from 'src/group/group.service';
@Controller()
export class GroupController {
  constructor(
    private readonly messageService: MessageService,
    private readonly groupService: GroupService,
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
      data: { threadId: trd.id, groupId: trd.id }
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('group/invite')
  async inviteUsers(@Request() req, @Body() params: { userId: number, groupId: number }): Promise<StandardResponse> {
    const groupMember = await this.groupService.findUniqeGroupMember({
      where: { groupId_userId: { groupId: params.groupId, userId: req.user.userId } }
    })
    if (groupMember === null) {
      return {
        status: 2,
        message: `you are not in group [${params.groupId}]`
      }
    } else {
      const grpData = await this.groupService.findUniqeGroup({ id: params.groupId })
      const { isFriend, userMsgTr } = await this.messageService.getFriendship({ userId: req.user.userId, friendUserId: params.userId })
      if (isFriend) {
        const expiryDate = dayjs().add(3, 'day').valueOf()
        this.messageService.writeMsgToThread(req.user.userId, userMsgTr.threadId, JSON.stringify({
          type: 'GROUP_INVITE',
          fromUserId: req.user.userId,
          groupName: grpData.name,
          expiryDate,
          token: this.groupService.generateInviteToken({
            toUserId: userMsgTr.toObjId,
            groupId: params.groupId,
            expiryDate
          })
        }), ContentType.INVITE)
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
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('group/join')
  async joinGroup(@Request() req, @Body() params: { token: string }): Promise<StandardResponse> {
    const res = this.groupService.decodeInviteDate(params)
    if (res.status === 0) {
      const data = res.data
      await this.groupService.joinGroup({ groupId: data.gid, userId: data.sub })
      return {
        status: 0,
        message: 'succesful'
      }
    } else if (res.status === 1) {
      return {
        status: 1,
        message: 'invalid invite'
      }
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('group/info')
  async getGroupInfo(@Request() req, @Body() params: { groupId: number }): Promise<StandardResponse> {
    const data = this.groupService.findUniqeGroup({ id: params.groupId })
    if (data !== null) {
      return {
        status: 0,
        message: 'succesful',
        data
      }
    } else {
      return {
        status: 1,
        message: `invalid groupId [${params.groupId}]`
      }
    }
  }
}