import {
  Controller,
  Post,
  Body,
  Headers,
  Ip,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { QrLoginService } from '../auth/qr-login.service.js';
import { setSessionCookies } from '../auth/media-token.js';
import { Public } from '../common/public.decorator.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { QrCreateDto, QrPollDto, QrTokenDto } from '../dto/auth.dto.js';

/**
 * QR-scan login (any client → session confirmed by an already-logged-in phone). create/poll are
 * `@Public()` (the QR-displaying client isn't authenticated yet); scan/confirm are authenticated (the
 * scanning phone is already logged in). `@Throttle` ceilings protect each step (they bypass
 * LocalStrategy's ban).
 *
 * The issued session `client` is the one chosen at create ('app' Android / 'desktop' Tauri / 'web'
 * browser), and its lifetime follows the platform's trust: `app` is always trusted (permanent); `desktop`
 * is trusted when its keyring is available (permanent) else a 14-day sliding session; `web` is always a
 * 14-day sliding session. So a trusted native client (Android/desktop) gets a permanent session via QR just
 * as it would via OTP.
 */
@ApiTags('auth')
@Controller()
@UseGuards(ThrottleGuard)
export class AuthQrController {
  constructor(private readonly qrLogin: QrLoginService) {}

  @Public()
  @Throttle(20, 60)
  @HttpCode(HttpStatus.OK)
  @Post('auth/qr/create')
  @ApiOperation({ summary: 'Begin QR sign-in: mint a token (the client renders it as a QR)' })
  async create(@Body() dto: QrCreateDto): Promise<ApiResult> {
    return {
      code: BusinessCode.OK,
      message: 'success',
      data: await this.qrLogin.create(dto.client ?? 'web', dto.trusted === true),
    };
  }

  @Public()
  @Throttle(60, 60) // ~1.5s poll cadence over the QR's 3-min lifetime
  @HttpCode(HttpStatus.OK)
  @Post('auth/qr/poll')
  @ApiOperation({ summary: 'Poll a QR token status (receives the session token once confirmed)' })
  async poll(
    @Body() dto: QrPollDto,
    @Headers('user-agent') userAgent: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResult> {
    const r = await this.qrLogin.poll(dto.qrToken, { device: dto.device, userAgent, ip });
    if (r.sessionToken) setSessionCookies(reply, r.sessionToken, true);
    return {
      code: BusinessCode.OK,
      message: 'success',
      data: r.sessionToken ? { status: r.status, session_token: r.sessionToken } : { status: r.status },
    };
  }

  @Throttle(20, 60)
  @HttpCode(HttpStatus.OK)
  @Post('auth/qr/scan')
  @ApiOperation({ summary: 'Phone scans a QR token (→ desktop shows "confirm on phone")' })
  async scan(@Req() req: FastifyRequest, @Body() dto: QrTokenDto): Promise<ApiResult> {
    await this.qrLogin.scan(dto.qrToken, (req.user as { userId: number }).userId);
    return { code: BusinessCode.OK, message: 'success' };
  }

  @Throttle(20, 60)
  @HttpCode(HttpStatus.OK)
  @Post('auth/qr/confirm')
  @ApiOperation({ summary: 'Phone confirms a scanned QR token (desktop receives a 2-week session)' })
  async confirm(@Req() req: FastifyRequest, @Body() dto: QrTokenDto): Promise<ApiResult> {
    await this.qrLogin.confirm(dto.qrToken, (req.user as { userId: number }).userId);
    return { code: BusinessCode.OK, message: 'success' };
  }
}
