import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Request,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import {
  CreateFcmProbeDto,
  RegisterDeviceDto,
  RegisterDeviceResultDto,
} from '../dto/device.dto.js';
import { PushService } from '../push/push.service.js';
import { ApiResultResponse } from '../common/api-result.js';

/** Session-owned push registration and interactive Android delivery diagnostics. */
@ApiTags('device')
@ApiBearerAuth()
@Controller()
export class DeviceController {
  constructor(private readonly pushService: PushService) {}

  @UseGuards(ThrottleGuard)
  @Throttle('device.register')
  @HttpCode(HttpStatus.OK)
  @Post('devices/register')
  @ApiResultResponse(RegisterDeviceResultDto)
  @ApiOperation({
    summary:
      'Register a Web Push or FCM subscription at the current session revision',
  })
  async register(
    @Request() req: FastifyRequest,
    @Body() dto: RegisterDeviceDto,
  ) {
    return this.pushService.registerToken(
      req.user.userId,
      req.user.sessionId as number,
      dto,
    );
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
