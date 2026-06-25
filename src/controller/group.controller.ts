import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MessageService } from '../message/message.service';
import { ContentType } from '../prisma/generated/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ApiResult, ApiResultResponse } from '../common/api-result';
import { BusinessCode } from '../common/business-code';
import * as dayjs from 'dayjs';
import { GroupService } from 'src/group/group.service';
import {
  CreateGroupDto,
  InviteGroupDto,
  JoinGroupDto,
  GroupIdDto,
} from '../dto/group.dto';
import {
  CreateGroupResponseDto,
  GroupResponseDto,
} from '../dto/response.dto';

@ApiTags('group')
@Controller()
export class GroupController {
  constructor(
    private readonly messageService: MessageService,
    private readonly groupService: GroupService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('group/create')
  @ApiOperation({ summary: '创建群组' })
  @ApiResultResponse(CreateGroupResponseDto)
  async createNewGroup(
    @Request() req,
    @Body() dto: CreateGroupDto,
  ): Promise<ApiResult> {
    const userId = req.user.userId;
    // groupName 长度校验已迁入 CreateGroupDto @MaxLength(31)（超长 → 200/10000）。
    const trd = await this.groupService.createNewGroup({
      owner: userId,
      groupName: dto.groupName,
    });
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: { threadId: trd.threadId, groupId: trd.id },
    };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('group/invite')
  @ApiOperation({ summary: '邀请用户入群（生成邀请 token 写入消息）' })
  async inviteUsers(
    @Request() req,
    @Body() dto: InviteGroupDto,
  ): Promise<ApiResult> {
    const groupMember = await this.groupService.findUniqeGroupMember({
      where: {
        groupId_userId: { groupId: dto.groupId, userId: req.user.userId },
      },
    });
    if (groupMember === null) {
      return {
        code: BusinessCode.GROUP_NOT_MEMBER,
        message: `you are not in group [${dto.groupId}]`,
      };
    } else {
      const grpData = await this.groupService.findUniqeGroup({
        id: dto.groupId,
      });
      const { isFriend, userMsgTr } = await this.messageService.getFriendship({
        userId: req.user.userId,
        friendUserId: dto.userId,
      });
      if (isFriend) {
        const expiryDate = dayjs().add(3, 'day').valueOf();
        this.messageService.writeMsgToThread(
          req.user.userId,
          userMsgTr.threadId,
          JSON.stringify({
            type: 'GROUP_INVITE',
            fromUserId: req.user.userId,
            groupName: grpData.name,
            expiryDate,
            token: this.groupService.generateInviteToken({
              toUserId: userMsgTr.toObjId,
              groupId: dto.groupId,
              expiryDate,
            }),
          }),
          ContentType.INVITE,
        );
        return {
          code: BusinessCode.OK,
          message: 'successful',
        };
      } else {
        return {
          code: BusinessCode.GROUP_NOT_FRIEND,
          message: `[${dto.userId}] is not your feiend`,
        };
      }
    }
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('group/join')
  @ApiOperation({ summary: '凭邀请 token 加入群组' })
  async joinGroup(
    @Request() req,
    @Body() dto: JoinGroupDto,
  ): Promise<ApiResult> {
    const res = this.groupService.decodeInviteDate(dto);
    if (res.status === 0) {
      const data = res.data;
      await this.groupService.joinGroup({
        groupId: data.gid,
        userId: data.sub,
      });
      return {
        code: BusinessCode.OK,
        message: 'succesful',
      };
    } else if (res.status === 1) {
      return {
        code: BusinessCode.GROUP_INVALID_TOKEN,
        message: 'invalid invite',
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('group/info')
  @ApiOperation({ summary: '查询群信息' })
  @ApiResultResponse(GroupResponseDto)
  async getGroupInfo(
    @Request() req,
    @Body() dto: GroupIdDto,
  ): Promise<ApiResult> {
    // 修复：原 findUniqeGroup 未 await（data 是 Promise，!==null 恒真，序列化为 {}）。
    const data = await this.groupService.findUniqeGroup({ id: dto.groupId });
    if (data !== null) {
      return {
        code: BusinessCode.OK,
        message: 'succesful',
        data,
      };
    } else {
      return {
        code: BusinessCode.NOT_FOUND,
        message: `invalid groupId [${dto.groupId}]`,
      };
    }
  }
}
