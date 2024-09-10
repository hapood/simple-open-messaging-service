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
  @Post('user/query-thread/from-pending')
  async queryPendingThread(
    @Request() req,
    @Body() params: {
      skip: number;
      take: number;
      lastId?: number;
      orderBy: 'desc' | 'asc'
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
        createdAt: params.orderBy,
      },
      include: {
        threadItem: true
      }
    };
    return await this.userService.queryUserThread(newParams)
  }

  @UseGuards(JwtAuthGuard)
  @Post('user/make-friend-request')
  async makeFriendRequest(@Request() req,
    @Body() params: { uniqName: string; },
  ) {
    const friend = await this.userService.findUniqueUser({ uniqName: params.uniqName }, false)
    if (req.user.userId === friend.id) {
      return {
        status: 3,
        message: 'can not make friend with self'
      }
    }
    if (friend) {
      //status 0,1,2
      return this.userService.makeFriendRequest(req.user.userId, friend.id);
    } else {
      return {
        status: 4,
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
}