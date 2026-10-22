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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ThrottleGuard, Throttle } from '../rate-limit/throttle.guard.js';
import {
  RegisterDeviceDto,
  RegisterDeviceResultDto,
  PushProbeStatusDto,
} from '../dto/device.dto.js';
import { PushService } from '../push/push.service.js';
import { ApiResultResponse } from '../common/api-result.js';

/** Session-owned push registration and interactive delivery diagnostics. */
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
  @Post('devices/push-probes')
  @ApiResultResponse(PushProbeStatusDto)
  @ApiOperation({
    summary:
      'Start an end-to-end push delivery probe for the authenticated session',
  })
  async createPushProbe(@Request() req: FastifyRequest) {
    return this.pushService.createPushProbe(
      req.user.userId,
      req.user.sessionId as number,
    );
  }

  @Get('devices/push-probes/:probeId')
  @ApiResultResponse(PushProbeStatusDto)
  @ApiOperation({
    summary: 'Read a one-off session push delivery probe status',
  })
  getPushProbe(
    @Request() req: FastifyRequest,
    @Param('probeId') probeId: string,
  ) {
    return this.pushService.getPushProbe(
      req.user.userId,
      req.user.sessionId as number,
      probeId,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('devices/push-probes/:probeId/ack')
  @ApiResultResponse(PushProbeStatusDto)
  @ApiOperation({
    summary: 'Acknowledge that this session received a push delivery probe',
  })
  acknowledgePushProbe(
    @Request() req: FastifyRequest,
    @Param('probeId') probeId: string,
  ) {
    return this.pushService.acknowledgePushProbe(
      req.user.userId,
      req.user.sessionId as number,
      probeId,
    );
  }
}
