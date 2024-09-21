import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards
} from '@nestjs/common';
import { UserService } from '../user/user.service';
import { Prisma, UserMessageThreadStatus, MessageThreadType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StandardResponse } from './utils'

@Controller()
export class UserController {
  constructor(
    private readonly userService: UserService
  ) { }


  @UseGuards(JwtAuthGuard)
  @Post('user/my-profile')
  async getMyProfile(@Request() req,
  ) {
    const data = await this.userService.findUniqueUser({ id: req.user.userId })
    delete data.hashPwd
    return data
  }

  @UseGuards(JwtAuthGuard)
  @Post('user/query-thread/valid')
  async queryValidThread(
    @Request() req,
    @Body() params: {
      skip: number;
      take: number;
      lastId?: number;
    },
  ) {
    const newParams: Prisma.UserMessageThreadFindManyArgs = {
      skip: params.skip,
      take: params.take,
      where: {
        userId: req.user.userId,
        toObjType: MessageThreadType.P2P_MESSAGE,
        status: UserMessageThreadStatus.APPROVED
      },
      orderBy: {
        id: 'asc',
      },
    };
    const list = await this.userService.queryUserThread(newParams)
    return {
      status: 0,
      message: 'successful',
      data: list
    }

  }

  @UseGuards(JwtAuthGuard)
  @Post('user/query-thread/to-pending')
  async queryPendingThread(
    @Request() req,
    @Body() params: {
      beforeDate: number;
      take: number;
    },
  ): Promise<StandardResponse> {
    const newParams: Prisma.UserMessageThreadFindManyArgs = {
      take: params.take,
      where: {
        userId: req.user.userId,
        toObjType: MessageThreadType.P2P_MESSAGE,
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
  ) {
    if (req.user.userId === params.userId) {
      return {
        status: 3,
        message: 'can not make friend with self'
      }
    }
    const friend = await this.userService.findUniqueUser({ id: params.userId }, false)
    if (friend) {
      //status 0,1,2
      return this.userService.makeFriendRequest(req.user.userId, friend.id);
    } else {
      return {
        status: 3,
        message: 'friend does not not exist'
      }
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('user/accept-friend-request')
  async acceptFriendRequest(@Request() req,
    @Body() params: { userId: number; },
  ) {
    return this.userService.acceptFriendRequest(params.userId, req.user.userId)
  }

  @Post('user/register')
  registerLocal(@Body() params: { uniqName: string; password: string },) {
    return this.userService.registerLocal(params)
  }

  @UseGuards(JwtAuthGuard)
  @Post('user/query')
  async queryUserBase(@Body() { userIds }: { userIds: number[] },) {
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
    delete user.hashPwd
    if (user !== null) {
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
}
