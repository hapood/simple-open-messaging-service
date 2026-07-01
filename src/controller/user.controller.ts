import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiConsumes,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserService } from '../user/user.service';
import { UploadService } from '../upload/upload.service';
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
import { SseService } from 'src/gateway/sse.service';
import { serializeBody } from '../common/serialize.interceptor';
import { ApiResult, ApiResultResponse } from '../common/api-result';
import { BusinessCode } from '../common/business-code';
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
  UpdateProfileDto,
} from '../dto/user.dto';

@ApiTags('user')
@Controller()
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly messageService: MessageService,
    private readonly authService: AuthService,
    private readonly groupService: GroupService,
    private readonly uploadService: UploadService,
    private readonly sseService: SseService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/my-profile')
  @ApiOperation({ summary: '获取当前用户资料' })
  @ApiResultResponse(UserResponseDto)
  async getMyProfile(@Request() req): Promise<ApiResult> {
    const data = await this.userService.findUniqueUser({ id: req.user.userId });
    delete data.hashPwd;
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/update-avatar')
  @ApiOperation({
    summary: '更新当前用户头像（multipart file；sharp 重写为 32/64/128/256/512 多档 webp）',
  })
  @UseInterceptors(FileInterceptor('file', UploadService.multerOptions))
  @ApiConsumes('multipart/form-data')
  async updateAvatar(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<ApiResult> {
    if (!file) {
      return { code: BusinessCode.VALIDATION_FAILED, message: 'no file' };
    }
    // magic number 前置：快速拒绝伪造 mimetype 的非图片（sharp 会在 saveAvatars 里二次校验）。
    if (!this.uploadService.isImage(file.mimetype, file.buffer)) {
      return { code: BusinessCode.VALIDATION_FAILED, message: 'invalid image' };
    }
    // 先读旧头像 → 落盘新多档 → 写库 → 清旧全部尺寸（顺序保证 DB 已更新才删旧文件）。
    const old = await this.userService.findUniqueUser({ id: req.user.userId });
    let url: string;
    try {
      url = await this.uploadService.saveAvatars(file.buffer);
    } catch {
      // sharp decode 失败（损坏/像素炸弹/非图）→ 一律按 invalid image 拒绝，不落盘不写库。
      return { code: BusinessCode.VALIDATION_FAILED, message: 'invalid image' };
    }
    await this.userService.updateAvatar(req.user.userId, url);
    await this.uploadService.deleteByUrl(old?.userExtra?.avatar ?? '');
    return { code: BusinessCode.OK, message: 'successful', data: { avatar: url } };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/update-profile')
  @ApiOperation({ summary: '更新当前用户昵称/简介（handle 不可改）' })
  @ApiResultResponse(UserResponseDto)
  async updateProfile(
    @Request() req,
    @Body() dto: UpdateProfileDto,
  ): Promise<ApiResult> {
    const data = await this.userService.updateProfile(req.user.userId, dto);
    delete data.hashPwd;
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
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
      code: BusinessCode.OK,
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
  @HttpCode(HttpStatus.OK)
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
      code: BusinessCode.OK,
      message: 'successful',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/query-thread/from-pending')
  @ApiOperation({ summary: '查询我发出的待处理好友请求' })
  @ApiResultResponse(UserMessageThreadResponseDto, true)
  async queryFromPendingThread(
    @Request() req,
    @Body() dto: QueryPendingThreadDto,
  ): Promise<ApiResult> {
    const newParams: Prisma.UserMessageThreadFindManyArgs = {
      take: dto.take,
      skip: dto.skip,
      where: {
        userId: req.user.userId,
        toObjType: MessageThreadType.P2P,
        status: UserMessageThreadStatus.FROM_PENDING,
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
      code: BusinessCode.OK,
      message: 'successful',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/send-friend-request')
  @ApiOperation({ summary: '发送好友请求' })
  async sendFriendRequest(
    @Request() req,
    @Body() dto: UserIdDto,
  ): Promise<ApiResult> {
    if (req.user.userId === dto.userId) {
      return {
        code: BusinessCode.FRIEND_SELF,
        message: 'can not make friend with self',
      };
    }
    const friend = await this.userService.findUniqueUser(
      { id: dto.userId },
      false,
    );
    if (!friend) {
      return {
        code: BusinessCode.NOT_FOUND,
        message: 'friend does not exist',
      };
    }
    // makeFriendRequest 状态语义见 message.service.ts：
    //  0 首次发请求 / 1 已是好友 / 2 删除后重发 / 3 对端先发过→互加成功 / 4 不应发生 / 5 对端待处理或已拉黑
    // 不同结果给前端准确文案（前端按 code===0 判成功、回显 message），而非一律 "request sent"。
    const res = await this.messageService.makeFriendRequest(
      req.user.userId,
      friend.id,
    );
    // status 0 (first request) and 2 (deleted→reset) both create a fresh TO_PENDING
    // for the recipient → push a live NOTIFY so their badge arms instantly (the
    // Notify row + hasUrFriendReq flag were already written atomically in the tx).
    if (res.status === 0 || res.status === 2) {
      this.sseService.onNotify(
        friend.id,
        serializeBody({
          event: 'NOTIFY',
          type: 'FRIEND_REQUEST',
          fromUserId: req.user.userId,
        }),
      );
    }
    switch (res.status) {
      case 0:
      case 2:
        return { code: BusinessCode.OK, message: 'friend request sent' };
      case 1:
        return { code: BusinessCode.OK, message: 'you are already friends' };
      case 3:
        return { code: BusinessCode.OK, message: 'you are now friends' };
      case 5:
        // 对端 TO_PENDING（已发过、幂等）或 BLOCKED。后者不回显"被拉黑"以免泄露屏蔽状态。
        return { code: BusinessCode.OK, message: 'friend request sent' };
      default:
        // status 4：状态机不应到达
        return {
          code: BusinessCode.FRIEND_UNKNOWN_STATE,
          message: 'unknown error',
        };
    }
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
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
        code: BusinessCode.OK,
        message: 'friend request approved',
      };
    } else {
      return {
        code: BusinessCode.FRIEND_NO_INCOMING,
        message: `user [${dto.userId}] did not send you a friend request.`,
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/decline-friend-request')
  @ApiOperation({ summary: '拒绝好友请求' })
  async declineFriendRequest(
    @Request() req,
    @Body() dto: UserIdDto,
  ): Promise<ApiResult> {
    const res = await this.messageService.declineFriendRequest(
      dto.userId,
      req.user.userId,
    );
    if (res.status === 0) {
      return {
        code: BusinessCode.OK,
        message: 'friend request declined',
      };
    } else {
      return {
        code: BusinessCode.FRIEND_NO_INCOMING,
        message: `user [${dto.userId}] did not send you a friend request.`,
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/cancel-friend-request')
  @ApiOperation({ summary: '撤销我发出的好友请求' })
  async cancelFriendRequest(
    @Request() req,
    @Body() dto: UserIdDto,
  ): Promise<ApiResult> {
    const res = await this.messageService.cancelFriendRequest(
      req.user.userId,
      dto.userId,
    );
    if (res.status === 0) {
      return {
        code: BusinessCode.OK,
        message: 'friend request cancelled',
      };
    } else {
      return {
        code: BusinessCode.FRIEND_NO_INCOMING,
        message: `user [${dto.userId}] has no pending request from you.`,
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/query')
  @ApiOperation({ summary: '按 userId 批量查用户（≤100）' })
  @ApiResultResponse(UserResponseDto, true)
  async queryUserBase(@Body() dto: QueryUsersDto): Promise<ApiResult> {
    // 上限 100 的校验已移入 QueryUsersDto 的 @ArrayMaxSize(100) → 失败走 ValidationPipe → 200/10000
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
      code: BusinessCode.OK,
      message: 'successful',
      data: list,
    };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
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
        code: BusinessCode.OK,
        message: 'successful',
        data: user,
      };
    } else {
      return {
        code: BusinessCode.NOT_FOUND,
        message: `can not find user [${dto.uniqName}]`,
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
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
    if (
      thread !== null &&
      thread.userId === req.user.userId &&
      thread.status !== UserMessageThreadStatus.DELETED
    ) {
      if (thread.toObjType === 'P2P') {
        (thread as any).userItem = await this.userService.findUniqueUser({
          id: thread.toObjId,
        });
      } else if (thread.toObjType === 'GROUP') {
        (thread as any).groupItem = await this.groupService.findUniqeGroup({
          id: thread.toObjId,
        });
      }
      return { code: BusinessCode.OK, message: 'successful', data: thread };
    } else {
      return {
        code: BusinessCode.NOT_FOUND,
        message: `user has no thread [${dto.userThreadId}]`,
      };
    }
  }

  @ApiTags('auth')
  @HttpCode(HttpStatus.OK)
  @Post('user/register')
  @ApiOperation({ summary: '注册新用户' })
  async registerLocal(@Body() dto: RegisterDto): Promise<ApiResult> {
    /* uniqName/password 的格式校验（regex）已移入 RegisterDto 的 @Matches → 失败走 ValidationPipe → 200/10000。
       业务校验（uniqName 重复）仍在 service，走 200 + ALREADY_EXISTS。 */
    const res = await this.userService.addUser({
      uniqName: dto.uniqName,
      hashPwd: await this.authService.hashStr(dto.password),
    });
    if (res.status === 2) {
      return {
        code: BusinessCode.ALREADY_EXISTS,
        message: `User ${dto.uniqName} already exists`,
      };
    } else {
      return {
        code: BusinessCode.OK,
        message: 'successfuly registered',
        data: res.data,
      };
    }
  }
}
