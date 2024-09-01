import {
  Controller,
  Get,
  Param,
  Post,
  Body,
  Put,
  Delete,
  Request,
  UseGuards
} from '@nestjs/common';
import { UserService } from './user/user.service';
import { User as UserModel, Friend as FriendModel, ContentType, Prisma, UserChatThread } from '@prisma/client';
import { LocalAuthGuard } from './auth/local-auth.guard';
import { AuthService } from './auth/auth.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard';

Date.prototype.toJSON = function () {
  return this.getTime()
}

const json = (param: any): any => {
  return JSON.stringify(
    param,
    (key, value) => {
      if (typeof value === "bigint") {
        return value.toString()
      } else {
        return value
      }
    }
  );
};

@Controller()
export class AppController {
  constructor(
    private readonly userService: UserService, private authService: AuthService
  ) { }


  @UseGuards(JwtAuthGuard)
  @Get('my-profile')
  async getMyProfile(@Request() req,
  ) {
    return await this.userService.findOne({ id: req.user.userId })
  }

  @UseGuards(JwtAuthGuard)
  @Post('query-friend-info')
  async queryFriendInfo(
    @Request() req,
    @Body() params: { userId: number },
  ): Promise<FriendModel> {
    return await this.userService.findFriend({ hostUserId: req.user.userId, friendUserId: params.userId })
  }

  @UseGuards(JwtAuthGuard)
  @Post('query-thread-info')
  async queryThreadInfo(
    @Request() req,
    @Body() params: { threadId: number },
  ): Promise<UserChatThread> {
    return await this.userService.findUserThread({ userId: req.user.userId, threadId: params.threadId })
  }

  @UseGuards(JwtAuthGuard)
  @Get('get-user-list')
  async getPostById(@Param('id') id: string): Promise<UserModel[]> {
    return this.userService.getUserList({});
  }

  @UseGuards(JwtAuthGuard)
  @Post('add-user')
  async signupUser(
    @Body() userData: { uniqName: string; password: string },
  ): Promise<UserModel> {
    const newData = {
      uniqName: userData.uniqName.trim(),
      password: userData.password.trim(),
      isForeigner: false,
      domain: "qifa.io"
    }
    return this.userService.createUser(newData);
  }

  @UseGuards(JwtAuthGuard)
  @Post('add-friend')
  async addFriend(@Request() req,
    @Body() userData: { uniqName: string; },
  ) {
    const friend = await this.userService.findOne({ uniqName: userData.uniqName })
    if (req.user.userId === friend.id) throw new Error("can not add self")
    if (friend) {
      await this.userService.createFriend(req.user.userId, friend.id);
      return true
    }
    throw new Error("no firend info")
  }

  @UseGuards(JwtAuthGuard)
  @Post('get-friend-list')
  async getFriendList(@Request() req,
  ) {
    return await this.userService.getFriendList(req.user.userId)
  }

  @UseGuards(JwtAuthGuard)
  @Post('get-thread-list')
  async getChatThreadList(@Request() req,
  ) {
    return await this.userService.getChatThreadList(req.user.userId)
  }

  @UseGuards(JwtAuthGuard)
  @Post('send-message')
  async sendMessage(@Request() req,
    @Body() params: { threadId: number, content: string },
  ) {
    if (!params.content) {
      return
    }
    const list = await this.userService.sendMessageToThread(req.user.userId, params.threadId, params.content, ContentType.PURE_STRING)
    return json(list)
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
      where: {
        threadId: params.threadId,
      },
      orderBy: {
        id: params.orderBy,
      },
    };
    if (params.lastId) {
      newParams.cursor = { id: params.lastId }
    }
    const list = await this.userService.queryMessages(newParams)
    return json(list)
  }

  @UseGuards(LocalAuthGuard)
  @Post('auth/login')
  async login(@Request() req) {
    return this.authService.login(req.user);
  }
}