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
import { QrLoginService } from '../auth/qr-login.service.js';
import { setSessionCookies } from '../auth/media-token.js';
import { Public } from '../common/public.decorator.js';
import { QrCreateDto, QrPollDto, QrTokenDto } from '../dto/auth.dto.js';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard.js';
import { UseRateLimitPolicy } from '../rate-limit/rate-limit.decorator.js';
import { AUTH_RATE_LIMIT_POLICIES } from '../rate-limit/auth-policy.registry.js';

/**
 * QR-scan login (any client → session confirmed by an already-logged-in phone). create/poll are
 * `@Public()` (the QR-displaying client isn't authenticated yet); scan/confirm are authenticated (the
 * scanning phone is already logged in). Dedicated rate-limit policies protect every step.
 *
 * The issued session `client` is retained as informational device metadata only.
 *
 * Handlers return raw data (create/poll) or nothing (scan/confirm acks); the global SerializeInterceptor
 * wraps the ApiResult envelope.
 */
@ApiTags('auth')
@Controller()
export class AuthQrController {
  constructor(private readonly qrLogin: QrLoginService) {}

  @Public()
  @UseRateLimitPolicy(AUTH_RATE_LIMIT_POLICIES.qrCreate)
  @UseGuards(RateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @Post('auth/qr/create')
  @ApiOperation({
    summary: 'Begin QR sign-in: mint a token (the client renders it as a QR)',
  })
  async create(@Body() dto: QrCreateDto) {
    return this.qrLogin.create(dto.client ?? 'web');
  }

  @Public()
  @UseRateLimitPolicy(AUTH_RATE_LIMIT_POLICIES.qrPoll)
  @UseGuards(RateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @Post('auth/qr/poll')
  @ApiOperation({
    summary:
      'Poll a QR token status (receives the session token once confirmed)',
  })
  async poll(
    @Body() dto: QrPollDto,
    @Headers('user-agent') userAgent: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.qrLogin.poll(dto.qrToken, {
      device: dto.device,
      userAgent,
      ip,
    });
    if (r.sessionToken) setSessionCookies(reply, r.sessionToken);
    return r.sessionToken
      ? { status: r.status, session_token: r.sessionToken }
      : { status: r.status };
  }

  @UseRateLimitPolicy(AUTH_RATE_LIMIT_POLICIES.qrScan)
  @UseGuards(RateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @Post('auth/qr/scan')
  @ApiOperation({
    summary: 'Phone scans a QR token (→ desktop shows "confirm on phone")',
  })
  async scan(
    @Req() req: FastifyRequest,
    @Body() dto: QrTokenDto,
  ): Promise<void> {
    await this.qrLogin.scan(
      dto.qrToken,
      (req.user as { userId: number }).userId,
    );
  }

  @UseRateLimitPolicy(AUTH_RATE_LIMIT_POLICIES.qrConfirm)
  @UseGuards(RateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @Post('auth/qr/confirm')
  @ApiOperation({ summary: 'Phone confirms a scanned QR token' })
  async confirm(
    @Req() req: FastifyRequest,
    @Body() dto: QrTokenDto,
  ): Promise<void> {
    await this.qrLogin.confirm(
      dto.qrToken,
      (req.user as { userId: number }).userId,
      req.user.sessionId ?? undefined,
    );
  }
}
