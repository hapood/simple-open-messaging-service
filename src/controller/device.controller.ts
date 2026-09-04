import {
  Controller,
  Post,
  Delete,
  Get,
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
import { CreateFcmProbeDto, RegisterDeviceDto } from '../dto/device.dto.js';
import { PushService } from '../push/push.service.js';

/**
 * Device registration for FCM push. The client obtains an FCM registration token from the platform
 * Firebase SDK and links it to the logged-in account via POST /devices/register; the server fans out
 * data-only `NEW_MESSAGE` payloads to registered devices. Delivery is suppressed only when the exact
 * authenticated device session has a live SSE connection.
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
  @Throttle('device.register')
  @HttpCode(HttpStatus.OK)
  @Post('devices/register')
  @ApiOperation({
    summary: 'Register/refresh an FCM push token for the logged-in user',
  })
  async register(
    @Request() req: FastifyRequest,
    @Body() dto: RegisterDeviceDto,
  ): Promise<void> {
    await this.pushService.registerToken(
      req.user.userId,
      req.user.sessionId as number,
      dto,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Delete('devices/register/:token')
  @ApiOperation({ summary: 'Unregister an FCM push token (called on logout)' })
  async unregister(
    @Request() req: FastifyRequest,
    @Param('token') token: string,
  ): Promise<void> {
    await this.pushService.unregisterToken(req.user.userId, token);
  }

  @HttpCode(HttpStatus.OK)
  @Post('devices/fcm-probes')
  @ApiOperation({
    summary:
      'Start an end-to-end FCM delivery probe for the current Android device',
  })
  async createFcmProbe(
    @Request() req: FastifyRequest,
    @Body() dto: CreateFcmProbeDto,
  ) {
    return this.pushService.createFcmProbe(req.user.userId, dto.token);
  }

  @Get('devices/fcm-probes/:probeId')
  @ApiOperation({ summary: 'Read a one-off FCM delivery probe status' })
  getFcmProbe(
    @Request() req: FastifyRequest,
    @Param('probeId') probeId: string,
  ) {
    return this.pushService.getFcmProbe(req.user.userId, probeId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('devices/fcm-probes/:probeId/ack')
  @ApiOperation({
    summary:
      'Acknowledge that the Android device received an FCM delivery probe',
  })
  acknowledgeFcmProbe(
    @Request() req: FastifyRequest,
    @Param('probeId') probeId: string,
  ) {
    return this.pushService.acknowledgeFcmProbe(req.user.userId, probeId);
  }
}
