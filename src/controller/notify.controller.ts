import {
  Controller,
  Post,
  Request,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NotifyService } from '../notify/notify.service';
import { ApiResult } from '../common/api-result';
import { BusinessCode } from '../common/business-code';

/**
 * Notification endpoints. The notify write path is triggered inside
 * MessageService.makeFriendRequest (atomic); this controller owns the read-side
 * "mark seen" action that clears the friend-request unread badge.
 */
@ApiTags('notify')
@Controller()
export class NotifyController {
  constructor(private readonly notifyService: NotifyService) {}

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('notify/mark-friend-req-read')
  @ApiOperation({ summary: '清除好友请求未读标记（用户已查看好友请求面板）' })
  async markFriendReqRead(@Request() req): Promise<ApiResult> {
    await this.notifyService.markFriendReqRead(req.user.userId);
    return { code: BusinessCode.OK, message: 'successful' };
  }
}
