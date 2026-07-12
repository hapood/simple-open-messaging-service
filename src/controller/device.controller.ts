import {
  Controller,
  Post,
  Delete,
  Body,
  Param,
  Request,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { RegisterDeviceDto } from '../dto/device.dto.js';
import { PushService } from '../push/push.service.js';

/**
 * Device registration for FCM push. The client obtains an FCM registration token from the platform
 * Firebase SDK and links it to the logged-in account via POST /devices/register; the server fans out
 * data-only FCM messages to these tokens on NEW_MESSAGE for recipients with no live SSE connection.
 *
 * Token lifecycle: re-register (upsert on token) on every token rotation / app start, bumping
 * lastSeenAt; DELETE on logout so the server stops pushing to a logged-out device. The Android client
 * re-registers on the next login, so a forgotten unregister self-heals the next time the deviceauth
 * token rotates.
 */
@ApiTags('device')
@ApiBearerAuth()
@Controller()
export class DeviceController {
  constructor(private readonly pushService: PushService) {}

  @UseGuards(ThrottleGuard)
  @Throttle(10, 60) // token rotation is rare: 10 registers/min per user is ample headroom
  @HttpCode(HttpStatus.OK)
  @Post('devices/register')
  @ApiOperation({ summary: 'Register/refresh an FCM push token for the logged-in user' })
  async register(
    @Request() req: FastifyRequest,
    @Body() dto: RegisterDeviceDto,
  ): Promise<ApiResult> {
    await this.pushService.registerToken(req.user.userId, dto);
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @HttpCode(HttpStatus.OK)
  @Delete('devices/register/:token')
  @ApiOperation({ summary: 'Unregister an FCM push token (called on logout)' })
  async unregister(@Request() req: FastifyRequest, @Param('token') token: string): Promise<ApiResult> {
    await this.pushService.unregisterToken(req.user.userId, token);
    return { code: BusinessCode.OK, message: 'successful' };
  }
}
