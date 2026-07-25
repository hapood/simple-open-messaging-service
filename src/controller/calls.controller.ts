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
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
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
} from '../dto/call.dto.js';

/**
 * 1:1 WebRTC call endpoints. The server is the signaling coordinator + lifecycle owner ONLY — it never
 * carries media. Auth is the global SessionAuthGuard (req.user.userId); per-call authorization (friends
 * check, participant check) is enforced inside CallsService. Every route returns the ApiResult envelope.
 */
@ApiTags('calls')
@Controller()
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  @UseGuards(ThrottleGuard)
  @Throttle(20, 60) // initiate ceiling: 20 new calls/min (abuse / accidental-flood guard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/initiate')
  @ApiOperation({ summary: 'Initiate a 1:1 call (rings the callee in-band + to all devices)' })
  async initiate(
    @Request() req: FastifyRequest,
    @Body() dto: InitiateCallDto,
  ): Promise<ApiResult> {
    const data = await this.calls.initiate(req.user.userId, dto);
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  @UseGuards(ThrottleGuard)
  @Throttle(60, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/accept')
  @ApiOperation({ summary: 'Accept an incoming call (callee)' })
  async accept(
    @Request() req: FastifyRequest,
    @Body() dto: AnswerCallDto,
  ): Promise<ApiResult> {
    await this.calls.accept(req.user.userId, dto.callSid);
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(ThrottleGuard)
  @Throttle(60, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/ringing')
  @ApiOperation({ summary: 'Acknowledge the incoming ring is alerting the callee (callee device)' })
  async ringing(
    @Request() req: FastifyRequest,
    @Body() dto: RingingCallDto,
  ): Promise<ApiResult> {
    await this.calls.ringing(req.user.userId, dto.callSid);
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(ThrottleGuard)
  @Throttle(60, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/connected')
  @ApiOperation({ summary: 'Report the media leg is up (either party) — the real connect marker' })
  async connected(
    @Request() req: FastifyRequest,
    @Body() dto: ConnectedCallDto,
  ): Promise<ApiResult> {
    await this.calls.connected(req.user.userId, dto.callSid);
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(ThrottleGuard)
  @Throttle(60, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/decline')
  @ApiOperation({ summary: 'Decline an incoming call (callee)' })
  async decline(
    @Request() req: FastifyRequest,
    @Body() dto: DeclineCallDto,
  ): Promise<ApiResult> {
    await this.calls.decline(req.user.userId, dto.callSid);
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(ThrottleGuard)
  @Throttle(60, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/cancel')
  @ApiOperation({ summary: 'Cancel a ringing call before the callee answers (caller)' })
  async cancel(
    @Request() req: FastifyRequest,
    @Body() dto: CancelCallDto,
  ): Promise<ApiResult> {
    await this.calls.cancel(req.user.userId, dto.callSid);
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(ThrottleGuard)
  @Throttle(60, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/end')
  @ApiOperation({ summary: 'End a connected call (either party)' })
  async end(
    @Request() req: FastifyRequest,
    @Body() dto: EndCallDto,
  ): Promise<ApiResult> {
    await this.calls.end(req.user.userId, dto.callSid, dto.endReason);
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(ThrottleGuard)
  @Throttle(300, 60) // ICE trickling is bursty — 300 relay frames/min (the client may also batch candidates)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('calls/signal')
  @ApiOperation({ summary: 'Relay one WebRTC signaling frame (offer/answer/ICE) to the peer' })
  async signal(
    @Request() req: FastifyRequest,
    @Body() dto: SignalCallDto,
  ): Promise<ApiResult> {
    await this.calls.signal(req.user.userId, dto);
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @ApiBearerAuth()
  @Get('calls/ice-servers')
  @ApiOperation({ summary: 'WebRTC ICE servers (STUN + time-limited TURN REST credentials)' })
  async iceServers(@Request() req: FastifyRequest): Promise<ApiResult> {
    // buildIceServers throws a server error on a PARTIAL TURN config (URLs without the REST secret,
    // or vice-versa) — a deployment misconfiguration fails loud rather than handing the client a
    // half-working set. A fully-unset TURN env (dev, no coturn) returns STUN-only / empty: that is
    // the normal no-TURN mode, not an error.
    const data = buildIceServers(req.user.userId);
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  @UseGuards(ThrottleGuard)
  @Throttle(30, 60) // fetched ~once per accept (an offline-then-online callee); low, bursty
  @ApiBearerAuth()
  @Get('calls/:callSid/signaling')
  @ApiOperation({
    summary: 'Fetch the staged setup signaling (offer/ICE) — for a peer that was offline when it trickled',
  })
  async signaling(
    @Request() req: FastifyRequest,
    @Param('callSid') callSid: string,
  ): Promise<ApiResult> {
    const data = await this.calls.signaling(req.user.userId, callSid);
    return { code: BusinessCode.OK, message: 'successful', data };
  }
}
