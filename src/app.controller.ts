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
import { User as UserModel, Friend as FriendModel, Message as MessageModal, ContentType, Prisma, UserChatThread } from '@prisma/client';
import { LocalAuthGuard } from './auth/local-auth.guard';
import { AuthService } from './auth/auth.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { request } from 'http';

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
  @Post('query-chat-thread-info')
  async queryChatThreadInfo(
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
  @Post('get-chat-thread-list')
  async getChatThreadList(@Request() req,
  ) {
    return await this.userService.getChatThreadList(req.user.userId)
  }

  @UseGuards(JwtAuthGuard)
  @Post('send-message')
  async sendMessage(@Request() req,
    @Body() params: { threadId: number, content: string },
  ) {
    await this.userService.sendMessageToThread(req.user.userId, params.threadId, params.content, ContentType.PURE_STRING)
  }

  @UseGuards(JwtAuthGuard)
  @Post('query-chat-messages')
  async queryChatMessages(@Request() req,
    @Body() params: {
      threadId: number,
      skip: number;
      take: number;
      lastId?: number;
      orderBy: 'desc' | 'asc'
    },
  ) {
    const newParams = {
      threadId: params.threadId,
      skip: params.skip,
      take: params.take,
      orderBy: params.orderBy,
    }
    if (params.lastId) {
      (newParams as any).cursor = {
        id: params.lastId,
      }
    }
    return await this.userService.queryChatMessages(newParams)
  }

  @UseGuards(LocalAuthGuard)
  @Post('auth/login')
  async login(@Request() req) {
    return this.authService.login(req.user);
  }
}