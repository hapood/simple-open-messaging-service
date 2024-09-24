import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards
} from '@nestjs/common';
import { UserService } from '../user/user.service';
import { GroupService } from 'src/group/group.service';
import { MessageService } from '../message/message.service';
import { Prisma, UserMessageThreadStatus, UserMessageThread, MessageThreadType, User, Group } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StandardResponse } from './utils'
import { AuthService } from 'src/auth/auth.service';

@Controller()
export class UserController {
  constructor(
    private readonly userService: UserService, private readonly messageService: MessageService,
    private readonly authService: AuthService, private readonly groupService: GroupService
  ) { }


  @UseGuards(JwtAuthGuard)
  @Post('user/my-profile')
  async getMyProfile(@Request() req,
  ): Promise<StandardResponse> {
    const data = await this.userService.findUniqueUser({ id: req.user.userId })
    delete data.hashPwd
    return { status: 0, message: 'successful', data }
  }

  @UseGuards(JwtAuthGuard)
  @Post('user/query-thread/valid')
  async queryValidThread(
    @Request() req,
    @Body() params: {
      skip: number;
      take: number;
      lastId?: number;
      toObjType?: MessageThreadType
    },
  ): Promise<StandardResponse> {
    const newParams: Prisma.UserMessageThreadFindManyArgs = {
      skip: params.skip,
      take: params.take,
      where: {
        userId: req.user.userId,
        toObjType: params.toObjType,
        status: UserMessageThreadStatus.APPROVED
      },
      orderBy: {
        id: 'asc',
      }
    };
    const list = await this.userService.queryUserThread(newParams)
    const userIds = [], groupIds = [];
    list.forEach(item => {
      if (item.toObjType === MessageThreadType.P2P) {
        userIds.push(item.toObjId)
      } else if (item.toObjType === MessageThreadType.GROUP) {
        groupIds.push(item.toObjId)
      }
    })
    const [userList, groupList] = await Promise.all([this.userService.queryUsers({
      where: {
        id: {
          in: userIds
        },
        isDeleted: false
      }
    }), this.groupService.queryGroups({
      where: {
        id: {
          in: groupIds
        }
      }
    })])
    const userDict: Record<number, User> = {}
    userList.forEach(item => {
      delete item.hashPwd
      userDict[item.id] = item
    })
    const groupDict: Record<number, Group> = {}
    groupList.forEach(item => {
      groupDict[item.id] = item
    })
    return {
      status: 0,
      message: 'successful',
      data: list.map(item => {
        if (item.toObjType === MessageThreadType.P2P) {
          (item as any).userItem = userDict[item.toObjId]
        } else if (item.toObjType === MessageThreadType.GROUP) {
          (item as any).groupItem = groupDict[item.toObjId]
        }
        return item
      })
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('user/query-thread/to-pending')
  async queryPendingThread(
    @Request() req,
    @Body() params: {
      beforeDate: number;
      take: number;
      skip: number
    },
  ): Promise<StandardResponse> {
    const newParams: Prisma.UserMessageThreadFindManyArgs = {
      take: params.take,
      skip: params.skip,
      where: {
        userId: req.user.userId,
        toObjType: MessageThreadType.P2P,
        status: UserMessageThreadStatus.TO_PENDING,
        updatedAt: {
          lt: new Date(params.beforeDate),
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
      include: {
        threadItem: true
      }
    };
    const data = await this.userService.queryUserThread(newParams)
    return {
      status: 0,
      message: 'successful',
      data
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('user/send-friend-request')
  async sendFriendRequest(@Request() req,
    @Body() params: { userId: number; },
  ): Promise<StandardResponse> {
    if (req.user.userId === params.userId) {
      return {
        status: 3,
        message: 'can not make friend with self'
      }
    }
    const friend = await this.userService.findUniqueUser({ id: params.userId }, false)
    if (friend) {
      //status 0,1,2
      const res = await this.messageService.makeFriendRequest(req.user.userId, friend.id);
      if (
        res.status === 0
        || res.status === 1 // already been friends
        || res.status === 2 // deleted and reset to TO_PENDING
        || res.status === 3 // firend is FROM_PENDING, set to APPROVED
        || res.status === 5 //don't bother any more when BLOCKED or TO_PENDING
      ) {
        return {
          status: 0,
          message: 'request sent successful'
        }
      } else if (res.status === 4) {
        // firend is FROM_PENDING, make friend error,should not happened
        return {
          status: 1,
          message: 'unknow error'
        }
      }
    } else {
      return {
        status: 2,
        message: 'friend does not not exist'
      }
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('user/approve-friend-request')
  async acceptFriendRequest(@Request() req,
    @Body() params: { userId: number; },
  ): Promise<StandardResponse> {
    const res = await this.messageService.approveFriendRequest(params.userId, req.user.userId)
    if (res.status === 0) {
      return {
        status: 0,
        message: 'already been friends'
      }
    } else {
      return {
        status: 1,
        message: `user [${params.userId}] did not send make friend request to you.`
      }
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('user/query')
  async queryUserBase(@Body() { userIds }: { userIds: number[] },): Promise<StandardResponse> {
    if (userIds.length > 100) {
      return {
        status: 1,
        message: 'must less than 100 userIds per query'
      }
    }
    const list = await this.userService.queryUsers({
      where: {
        id: {
          in: userIds
        },
        isDeleted: false
      },
      include: {
        userExtra: true
      }
    })
    list.forEach(item => {
      delete item.hashPwd
    })
    return {
      status: 0,
      message: 'successful',
      data: list
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('user/by-uniq-name')
  async getUserByUniqName(@Body() { uniqName }: { uniqName: string }): Promise<StandardResponse> {
    const user = await this.userService.findUniqueUser({
      uniqName,
      isDeleted: false
    }, true)
    if (user !== null) {
      delete user.hashPwd
      return {
        status: 0,
        message: 'successful',
        data: user
      }
    } else {
      return {
        status: 1,
        message: `can not find user [${uniqName}]`
      }
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('/user/thread-info')
  async queryUserThreadInfo(
    @Request() req,
    @Body() params: { userThreadId: number },
  ): Promise<StandardResponse<UserMessageThread>> {
    const thread = await this.messageService.findUniqueUserMessageThread({
      id: params.userThreadId
    })
    if (thread !== null && thread.userId === req.user.userId) {
      if (thread.toObjType === 'P2P') {
        (thread as any).userItem = await this.userService.findUniqueUser({ id: thread.toObjId })
      } else if (thread.toObjType === 'GROUP') {
        (thread as any).groupItem = await this.groupService.findUniqeGroup({ id: thread.toObjId })
      }
      return { status: 0, message: 'successful', data: thread }
    } else {
      return { status: 1, message: `user has no thread [${params.userThreadId}]` }
    }
  }

  @Post('user/register')
  async registerLocal(@Body() params: { uniqName: string; password: string },) {

    /*^ Start of string
      (?=[\w.-]{5,20}$) Assert 5-20 of the allowed characters
      (?:[\d_.-]*[a-zA-Z]){3} Match 3 times a-zA-Z followed by optional digits _ . -
      [\w.-]* Match optional word chars or . or -
      $ End of string
    */
    const nameRegex = /^(?=[\w.-]{1,20}$)(?:[\d_.-]*[a-zA-Z]){3}[\w.-]*$/
    const pwdRegex = /^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/
    if (nameRegex.test(params.uniqName) === false) {
      return {
        status: 1, message: `uniqName [${params.uniqName}] not match regex [${nameRegex}]`
      }
    } else if (pwdRegex.test(params.password) === false) {
      return {
        status: 1, message: `uniqName [${params.uniqName}] not match regex [${pwdRegex}]`
      }
    }
    const res = await this.userService.addUser({
      uniqName: params.uniqName, hashPwd: await this.authService.hashStr(params.password)
    })
    if (res.status === 2) {
      return {
        status: 2, message: `User ${params.uniqName} already exists`
      }
    } else {
      return {
        status: 0,
        message: 'successfuly registered',
        data: res.data
      }
    }
  }
}
