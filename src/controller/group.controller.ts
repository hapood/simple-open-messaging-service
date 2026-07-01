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
import { MessageService } from '../message/message.service.js';
import { ContentType } from '../prisma/generated/client.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ApiResult, ApiResultResponse } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import dayjs from 'dayjs';
import { GroupService } from '../group/group.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { FriendshipService } from '../friendship/friendship.service.js';
import {
  CreateGroupDto,
  InviteGroupDto,
  JoinGroupDto,
  GroupIdDto,
} from '../dto/group.dto.js';
import {
  CreateGroupResponseDto,
  GroupResponseDto,
} from '../dto/response.dto.js';

@ApiTags('group')
@Controller()
export class GroupController {
  constructor(
    private readonly messageService: MessageService,
    private readonly groupService: GroupService,
    private readonly participantService: ThreadParticipantService,
    private readonly friendshipService: FriendshipService,
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
  @ApiOperation({ summary: '邀请好友入群（生成邀请 token 写入 P2P 消息）' })
  async inviteUsers(
    @Request() req,
    @Body() dto: InviteGroupDto,
  ): Promise<ApiResult> {
    const group = await this.groupService.findUniqeGroup({ id: dto.groupId });
    if (group === null) {
      return {
        code: BusinessCode.NOT_FOUND,
        message: `no group [${dto.groupId}]`,
      };
    }
    // Inviter must be an active member of the group.
    const me = await this.participantService.findActiveParticipant(
      req.user.userId,
      group.threadId,
    );
    if (me === null) {
      return {
        code: BusinessCode.GROUP_NOT_MEMBER,
        message: `you are not in group [${dto.groupId}]`,
      };
    }
    // ...and must be friends with the invitee (with an established P2P thread to carry the invite).
    const { friendship, isFriend } = await this.friendshipService.getFriendship(
      req.user.userId,
      dto.userId,
    );
    if (!isFriend || !friendship?.threadId) {
      return {
        code: BusinessCode.GROUP_NOT_FRIEND,
        message: `[${dto.userId}] is not your friend`,
      };
    }
    const expiryDate = dayjs().add(3, 'day').valueOf();
    try {
      await this.messageService.writeMsgToThread(
        req.user.userId,
        friendship.threadId,
        JSON.stringify({
          type: 'GROUP_INVITE',
          fromUserId: req.user.userId,
          groupName: group.name,
          expiryDate,
          token: this.groupService.generateInviteToken({
            toUserId: dto.userId,
            groupId: dto.groupId,
            expiryDate,
          }),
        }),
        ContentType.INVITE,
      );
    } catch (e) {
      return {
        code: BusinessCode.INTERNAL,
        message: `invite write failed: ${(e as Error)?.message ?? String(e)}`,
      };
    }
    return { code: BusinessCode.OK, message: 'successful' };
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
    const res = this.groupService.decodeInviteToken(dto.token);
    switch (res.status) {
      case 0:
        // Fix for the invite-token identity bypass: the caller must be the token's intended recipient.
        if (res.data.sub !== req.user.userId) {
          return {
            code: BusinessCode.GROUP_INVALID_TOKEN,
            message: 'invite is not for you',
          };
        }
        const r = await this.groupService.joinGroup({
          groupId: res.data.gid,
          userId: req.user.userId,
        });
        return {
          code: BusinessCode.OK,
          message: r.status === 'ok' ? 'successful' : 'already a member',
        };
      case 2:
        return {
          code: BusinessCode.GROUP_INVALID_TOKEN,
          message: 'invite expired',
        };
      default:
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
  @ApiOperation({ summary: '查询群信息（仅成员）' })
  @ApiResultResponse(GroupResponseDto)
  async getGroupInfo(
    @Request() req,
    @Body() dto: GroupIdDto,
  ): Promise<ApiResult> {
    const group = await this.groupService.findUniqeGroup({ id: dto.groupId });
    if (group === null) {
      return {
        code: BusinessCode.NOT_FOUND,
        message: `invalid groupId [${dto.groupId}]`,
      };
    }
    // Fix for the info leak: only active members may read group details.
    const me = await this.participantService.findActiveParticipant(
      req.user.userId,
      group.threadId,
    );
    if (me === null) {
      return {
        code: BusinessCode.GROUP_NOT_MEMBER,
        message: `you are not in group [${dto.groupId}]`,
      };
    }
    return { code: BusinessCode.OK, message: 'successful', data: group };
  }
}
