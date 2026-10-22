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
import { CallsService } from '../calls/calls.service.js';
import { ThrottleGuard, Throttle } from '../rate-limit/throttle.guard.js';
import { buildIceServers } from '../calls/turn-credentials.js';
import {
  InitiateCallDto,
  AnswerCallDto,
  RingingCallDto,
  DeclineCallDto,
  CancelCallDto,
  EndCallDto,
  SignalCallDto,
  ConnectedCallDto,
  UpgradeCallVideoDto,
} from '../dto/call.dto.js';

/**
 * 1:1 WebRTC call endpoints. The server is the signaling coordinator + lifecycle owner ONLY — it never
 * carries media. Auth is the global SessionAuthGuard (req.user.userId); per-call authorization (friends
 * check, participant check) is enforced inside CallsService. Handlers return raw data (or void for acks);
 * the global SerializeInterceptor wraps the ApiResult envelope.
 */
@ApiTags('calls')
@Controller()
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  @UseGuards(ThrottleGuard)
  @Throttle('call.initiate')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/initiate')
  @ApiOperation({
    summary: 'Initiate a 1:1 call (rings the callee in-band + to all devices)',
  })
  async initiate(@Request() req: FastifyRequest, @Body() dto: InitiateCallDto) {
    return this.calls.initiate(req.user.userId, dto);
  }

  @UseGuards(ThrottleGuard)
  @Throttle('call.accept')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/accept')
  @ApiOperation({ summary: 'Accept an incoming call (callee)' })
  async accept(
    @Request() req: FastifyRequest,
    @Body() dto: AnswerCallDto,
  ): Promise<void> {
    await this.calls.accept(req.user.userId, dto.callSid);
  }

  @UseGuards(ThrottleGuard)
  @Throttle('call.ringing')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/ringing')
  @ApiOperation({
    summary:
      'Acknowledge the incoming ring is alerting the callee (callee device)',
  })
  async ringing(
    @Request() req: FastifyRequest,
    @Body() dto: RingingCallDto,
  ): Promise<void> {
    await this.calls.ringing(req.user.userId, dto.callSid);
  }

  @UseGuards(ThrottleGuard)
  @Throttle('call.connected')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/connected')
  @ApiOperation({
    summary: 'Report the media leg is up (callee-authoritative connect marker)',
  })
  async connected(
    @Request() req: FastifyRequest,
    @Body() dto: ConnectedCallDto,
  ): Promise<void> {
    await this.calls.connected(req.user.userId, dto.callSid);
  }

  @UseGuards(ThrottleGuard)
  @Throttle('call.upgrade-video')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/upgrade-video')
  @ApiOperation({
    summary: 'Caller commits an established audio call upgrade to video',
  })
  async upgradeVideo(
    @Request() req: FastifyRequest,
    @Body() dto: UpgradeCallVideoDto,
  ): Promise<void> {
    await this.calls.upgradeVideo(req.user.userId, dto.callSid);
  }

  @UseGuards(ThrottleGuard)
  @Throttle('call.decline')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/decline')
  @ApiOperation({ summary: 'Decline an incoming call (callee)' })
  async decline(
    @Request() req: FastifyRequest,
    @Body() dto: DeclineCallDto,
  ): Promise<void> {
    await this.calls.decline(req.user.userId, dto.callSid);
  }

  @UseGuards(ThrottleGuard)
  @Throttle('call.cancel')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/cancel')
  @ApiOperation({
    summary: 'Cancel a ringing call before the callee answers (caller)',
  })
  async cancel(
    @Request() req: FastifyRequest,
    @Body() dto: CancelCallDto,
  ): Promise<void> {
    await this.calls.cancel(req.user.userId, dto.callSid);
  }

  @UseGuards(ThrottleGuard)
  @Throttle('call.end')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/end')
  @ApiOperation({ summary: 'End a connected call (either party)' })
  async end(
    @Request() req: FastifyRequest,
    @Body() dto: EndCallDto,
  ): Promise<void> {
    await this.calls.end(req.user.userId, dto.callSid, dto.endReason);
  }

  @UseGuards(ThrottleGuard)
  @Throttle('call.signal')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/signal')
  @ApiOperation({
    summary: 'Relay one WebRTC signaling frame (offer/answer/ICE) to the peer',
  })
  async signal(
    @Request() req: FastifyRequest,
    @Body() dto: SignalCallDto,
  ): Promise<void> {
    await this.calls.signal(req.user.userId, dto);
  }

  @ApiBearerAuth()
  @Get('calls/ice-servers')
  @ApiOperation({
    summary: 'WebRTC ICE servers (STUN + time-limited TURN REST credentials)',
  })
  async iceServers(@Request() req: FastifyRequest) {
    // buildIceServers throws a server error on a PARTIAL TURN config (URLs without the REST secret,
    // or vice-versa) — a deployment misconfiguration fails loud rather than handing the client a
    // half-working set. A fully-unset TURN env (dev, no coturn) returns STUN-only / empty: that is
    // the normal no-TURN mode, not an error.
    return buildIceServers(req.user.userId);
  }

  @UseGuards(ThrottleGuard)
  @Throttle('call.signaling')
  @ApiBearerAuth()
  @Get('calls/:callSid/signaling')
  @ApiOperation({
    summary:
      'Fetch the staged setup signaling (offer/ICE) — for a peer that was offline when it trickled',
  })
  async signaling(
    @Request() req: FastifyRequest,
    @Param('callSid') callSid: string,
  ) {
    return this.calls.signaling(req.user.userId, callSid);
  }
}
