import {
  Controller,
  Post,
  Body,
  Headers,
  Ip,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { OtpLoginService } from '../auth/otp-login.service.js';
import { setSessionCookies } from '../auth/media-token.js';
import { Public } from '../common/public.decorator.js';
import { OtpLoginDto } from '../dto/auth.dto.js';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard.js';
import { UseRateLimitPolicy } from '../rate-limit/rate-limit.decorator.js';
import { AUTH_RATE_LIMIT_POLICIES } from '../rate-limit/auth-policy.registry.js';

/**
 * One-time-code (admin-issued) login — available on every platform. Distinct from the password-login
 * {@link AuthController} (its own throttle surface + it bypasses LocalStrategy's brute-force ban).
 * `@Public()` (callable pre-auth) with a dedicated abuse policy so a guessed 6-digit code can't be
 * brute-forced. The session `client` comes from the body (default 'app') and is informational only.
 */
@ApiTags('auth')
@Public()
@Controller()
export class AuthOtpController {
  constructor(private readonly otpLoginService: OtpLoginService) {}

  @UseRateLimitPolicy(AUTH_RATE_LIMIT_POLICIES.otpLogin)
  @UseGuards(RateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @Post('auth/otp/login')
  @ApiOperation({
    summary:
      'Login with an admin-issued one-time code (Android → long-term app session)',
  })
  async otpLogin(
    @Body() dto: OtpLoginDto,
    @Headers('user-agent') userAgent: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // verifyAndLogin throws BusinessException(OTP_INVALID | OTP_EXPIRED | OTP_CONSUMED) on failure → the
    // global filter renders it as HTTP 200 + business code (consistent with the rest of the auth surface).
    const { token, mustChangePassword } =
      await this.otpLoginService.verifyAndLogin(dto.account, dto.code, {
        device: dto.device,
        userAgent,
        ip,
        client: dto.client,
      });
    setSessionCookies(reply, token);
    return {
      session_token: token,
      ...(mustChangePassword ? { mustChangePassword: true } : {}),
    };
  }
}
