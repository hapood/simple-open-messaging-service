import { Controller, Post, Body, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserService } from '../user/user.service';
import { GroupService } from 'src/group/group.service';
import { MessageService } from '../message/message.service';
import {
  Prisma,
  UserMessageThreadStatus,
  MessageThreadType,
  User,
  Group,
} from '../prisma/generated/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthService } from 'src/auth/auth.service';
import { ApiResult, ApiResultResponse } from '../common/api-result';
import {
  UserResponseDto,
  UserMessageThreadResponseDto,
} from '../dto/response.dto';
import { RegisterDto } from '../dto/auth.dto';
import {
  UserIdDto,
  UserThreadIdDto,
  UserByUniqNameDto,
  QueryUsersDto,
  QueryValidThreadDto,
  QueryPendingThreadDto,
} from '../dto/user.dto';

@ApiTags('user')
@Controller()
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly messageService: MessageService,
    private readonly authService: AuthService,
    private readonly groupService: GroupService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('user/my-profile')
  @ApiOperation({ summary: '获取当前用户资料' })
  @ApiResultResponse(UserResponseDto)
  async getMyProfile(@Request() req): Promise<ApiResult> {
    const data = await this.userService.findUniqueUser({ id: req.user.userId });
    delete data.hashPwd;
    return { code: 0, message: 'successful', data };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('user/query-thread/valid')
  @ApiOperation({ summary: '查询有效会话列表（含对端 user/group 信息）' })
  @ApiResultResponse(UserMessageThreadResponseDto, true)
  async queryValidThread(
    @Request() req,
    @Body() dto: QueryValidThreadDto,
  ): Promise<ApiResult> {
    const newParams: Prisma.UserMessageThreadFindManyArgs = {
      skip: dto.skip,
      take: dto.take,
      where: {
        userId: req.user.userId,
        toObjType: dto.toObjType,
        status: UserMessageThreadStatus.APPROVED,
      },
      orderBy: {
        id: 'asc',
      },
    };
    const list = await this.userService.queryUserThread(newParams);
    const userIds = [],
      groupIds = [];
    list.forEach((item) => {
      if (item.toObjType === MessageThreadType.P2P) {
        userIds.push(item.toObjId);
      } else if (item.toObjType === MessageThreadType.GROUP) {
        groupIds.push(item.toObjId);
      }
    });
    const [userList, groupList] = await Promise.all([
      this.userService.queryUsers({
        where: {
          id: {
            in: userIds,
          },
          isDeleted: false,
        },
        include: {
          userExtra: true,
        },
      }),
      this.groupService.queryGroups({
        where: {
          id: {
            in: groupIds,
          },
        },
      }),
    ]);
    const userDict: Record<number, User> = {};
    userList.forEach((item) => {
      delete item.hashPwd;
      userDict[item.id] = item;
    });
    const groupDict: Record<number, Group> = {};
    groupList.forEach((item) => {
      groupDict[item.id] = item;
    });
    return {
      code: 0,
      message: 'successful',
      data: list.map((item) => {
        if (item.toObjType === MessageThreadType.P2P) {
          (item as any).userItem = userDict[item.toObjId];
        } else if (item.toObjType === MessageThreadType.GROUP) {
          (item as any).groupItem = groupDict[item.toObjId];
        }
        return item;
      }),
    };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('user/query-thread/to-pending')
  @ApiOperation({ summary: '查询待处理好友请求会话' })
  @ApiResultResponse(UserMessageThreadResponseDto, true)
  async queryPendingThread(
    @Request() req,
    @Body() dto: QueryPendingThreadDto,
  ): Promise<ApiResult> {
    const newParams: Prisma.UserMessageThreadFindManyArgs = {
      take: dto.take,
      skip: dto.skip,
      where: {
        userId: req.user.userId,
        toObjType: MessageThreadType.P2P,
        status: UserMessageThreadStatus.TO_PENDING,
        updatedAt: {
          lt: new Date(dto.beforeDate),
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
      include: {
        threadItem: true,
      },
    };
    const data = await this.userService.queryUserThread(newParams);
    return {
      code: 0,
      message: 'successful',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('user/send-friend-request')
  @ApiOperation({ summary: '发送好友请求' })
  async sendFriendRequest(
    @Request() req,
    @Body() dto: UserIdDto,
  ): Promise<ApiResult> {
    if (req.user.userId === dto.userId) {
      return {
        code: 3,
        message: 'can not make friend with self',
      };
    }
    const friend = await this.userService.findUniqueUser(
      { id: dto.userId },
      false,
    );
    if (friend) {
      //status 0,1,2
      const res = await this.messageService.makeFriendRequest(
        req.user.userId,
        friend.id,
      );
      if (
        res.status === 0 ||
        res.status === 1 || // already been friends
        res.status === 2 || // deleted and reset to TO_PENDING
        res.status === 3 || // firend is FROM_PENDING, set to APPROVED
        res.status === 5 //don't bother any more when BLOCKED or TO_PENDING
      ) {
        return {
          code: 0,
          message: 'request sent successful',
        };
      } else if (res.status === 4) {
        // firend is FROM_PENDING, make friend error,should not happened
        return {
          code: 1,
          message: 'unknow error',
        };
      }
    } else {
      return {
        code: 2,
        message: 'friend does not not exist',
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('user/approve-friend-request')
  @ApiOperation({ summary: '同意好友请求' })
  async acceptFriendRequest(
    @Request() req,
    @Body() dto: UserIdDto,
  ): Promise<ApiResult> {
    const res = await this.messageService.approveFriendRequest(
      dto.userId,
      req.user.userId,
    );
    if (res.status === 0) {
      return {
        code: 0,
        message: 'already been friends',
      };
    } else {
      return {
        code: 1,
        message: `user [${dto.userId}] did not send make friend request to you.`,
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('user/query')
  @ApiOperation({ summary: '按 userId 批量查用户（≤100）' })
  @ApiResultResponse(UserResponseDto, true)
  async queryUserBase(@Body() dto: QueryUsersDto): Promise<ApiResult> {
    // 上限 100 的校验已移入 QueryUsersDto 的 @ArrayMaxSize(100) → 失败走 ValidationPipe → 400
    const list = await this.userService.queryUsers({
      where: {
        id: {
          in: dto.userIds,
        },
        isDeleted: false,
      },
      include: {
        userExtra: true,
      },
    });
    list.forEach((item) => {
      delete item.hashPwd;
    });
    return {
      code: 0,
      message: 'successful',
      data: list,
    };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('user/by-uniq-name')
  @ApiOperation({ summary: '按 uniqName 查用户' })
  @ApiResultResponse(UserResponseDto)
  async getUserByUniqName(
    @Body() dto: UserByUniqNameDto,
  ): Promise<ApiResult> {
    const user = await this.userService.findUniqueUser(
      {
        uniqName: dto.uniqName,
        isDeleted: false,
      },
      true,
    );
    if (user !== null) {
      delete user.hashPwd;
      return {
        code: 0,
        message: 'successful',
        data: user,
      };
    } else {
      return {
        code: 1,
        message: `can not find user [${dto.uniqName}]`,
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('/user/thread-info')
  @ApiOperation({ summary: '查询会话详情（含对端 user/group）' })
  @ApiResultResponse(UserMessageThreadResponseDto)
  async queryUserThreadInfo(
    @Request() req,
    @Body() dto: UserThreadIdDto,
  ): Promise<ApiResult> {
    const thread = await this.messageService.findUniqueUserMessageThread({
      where: {
        id: dto.userThreadId,
      },
    });
    if (thread !== null && thread.userId === req.user.userId) {
      if (thread.toObjType === 'P2P') {
        (thread as any).userItem = await this.userService.findUniqueUser({
          id: thread.toObjId,
        });
      } else if (thread.toObjType === 'GROUP') {
        (thread as any).groupItem = await this.groupService.findUniqeGroup({
          id: thread.toObjId,
        });
      }
      return { code: 0, message: 'successful', data: thread };
    } else {
      return {
        code: 1,
        message: `user has no thread [${dto.userThreadId}]`,
      };
    }
  }

  @ApiTags('auth')
  @Post('user/register')
  @ApiOperation({ summary: '注册新用户' })
  async registerLocal(@Body() dto: RegisterDto): Promise<ApiResult> {
    /* uniqName/password 的格式校验（regex）已移入 RegisterDto 的 @Matches → 失败走 ValidationPipe → 400。
       业务校验（uniqName 重复）仍在 service，走 200 + code:2。 */
    const res = await this.userService.addUser({
      uniqName: dto.uniqName,
      hashPwd: await this.authService.hashStr(dto.password),
    });
    if (res.status === 2) {
      return {
        code: 2,
        message: `User ${dto.uniqName} already exists`,
      };
    } else {
      return {
        code: 0,
        message: 'successfuly registered',
        data: res.data,
      };
    }
  }
}
