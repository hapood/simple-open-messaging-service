import {
  Controller,
  Get,
  Param,
  Post,
  Body,
  Request,
  UseGuards
} from '@nestjs/common';
import { UserService } from '../user/user.service';
import { User as UserModel, Friend as FriendModel } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller()
export class UserController {
  constructor(
    private readonly userService: UserService
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
  @Post('add-user')
  async signupUser(
    @Body() userData: { uniqName: string; password: string },
  ) {
    const newData = {
      uniqName: userData.uniqName.trim(),
      password: userData.password.trim(),
      isForeigner: false,
      domain: "qifa.io"
    }
    return this.userService.createUser(newData);
  }

  @UseGuards(JwtAuthGuard)
  @Get('get-user-list')
  async getPostById(@Param('id') id: string): Promise<UserModel[]> {
    return this.userService.getUserList({});
  }

}