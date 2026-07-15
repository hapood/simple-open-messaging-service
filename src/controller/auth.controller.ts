import {
  Controller,
  Post,
  Request,
  UseGuards,
  Body,
  Headers,
  Ip,
  Res,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LocalAuthGuard } from '../auth/local-auth.guard.js';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { MEDIA_TOKEN_COOKIE, MEDIA_COOKIE_OPTIONS } from '../auth/media-token.js';
import {
  SessionTokenService,
  type SessionClient,
} from '../auth/session-token.service.js';
import { LoginAuthInfo } from '../auth/local.strategy.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { Public } from '../common/public.decorator.js';
import {
  LoginDto,
  LogoutDto,
  ChangePasswordDto,
  RevokeSessionDto,
} from '../dto/auth.dto.js';

@ApiTags('auth')
@Controller()
@UseGuards(ThrottleGuard)
export class AuthController {
  constructor(
    private authService: AuthService,
    private readonly sessionTokens: SessionTokenService,
  ) {}

  /** Mirror the session token into an httpOnly `media_token` cookie so same-origin /uploads/* requests
   *  (native <img>/<a download>, which can't send the Authorization header) are authenticated. Set on
   *  login; cleared on logout / change-password. Same validation path as the API (BearerAuthService) → a
   *  revoked session loses media access too. */
  private setMediaCookie(reply: FastifyReply, token: string) {
    reply.setCookie(MEDIA_TOKEN_COOKIE, token, MEDIA_COOKIE_OPTIONS);
  }

  /** Clear the media cookie — path must match the one used at set time for the browser to drop it. */
  private clearMediaCookie(reply: FastifyReply) {
    reply.clearCookie(MEDIA_TOKEN_COOKIE, { path: '/' });
  }

  @Public()
  @UseGuards(LocalAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('auth/login')
  @ApiOperation({ summary: 'Login (issue a long-lived per-device session token)' })
  // Login credentials are verified by LocalStrategy; the @Body DTO only consumes `device`/`client`, and
  // is whitelisted through the global ValidationPipe.
  @ApiBody({ type: LoginDto })
  async login(
    // LocalAuthGuard attaches the LoginAuthInfo LocalStrategy returns (richer than the C-end
    // `{ userId }` principal on FastifyRequest.user). Narrowing the param type — an intersection with
    // `{ user: LoginAuthInfo }` — expresses that at this route boundary, so the handler reads
    // status/account/userId with no cast and no non-null assertion.
    @Request() req: FastifyRequest & { user: LoginAuthInfo },
    @Body() body: LoginDto,
    @Headers('user-agent') userAgent: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResult> {
    const authInfo = req.user;
    if (authInfo.status === 0) {
      // status 0 (success) implies userId is set — see LocalStrategy.validate. Issue the single
      // long-lived session credential. 'app' → no-expiry (native, OS secure storage); 'web' (default) /
      // 'desktop' → sliding 30-day.
      const client: SessionClient = body.client ?? 'web';
      const session_token = await this.sessionTokens.issue(
        authInfo.userId!,
        client,
        { device: body.device, userAgent, ip },
      );
      this.setMediaCookie(reply, session_token);
      return { code: BusinessCode.OK, message: 'successful', data: { session_token } };
    } else {
      if (authInfo.bannedUntil !== undefined) {
        return {
          code: BusinessCode.RATE_LIMITED,
          message: 'too many bad attempts',
          data: { bannedUntil: authInfo.bannedUntil },
        };
      } else {
        return { code: BusinessCode.INVALID_CREDENTIALS, message: 'invalid credentials' };
      }
    }
  }

  @Public()
  @Throttle(30, 60)
  @HttpCode(HttpStatus.OK)
  @Post('auth/logout')
  @ApiOperation({ summary: 'Logout (revoke the presented session token)' })
  async logout(
    @Body() dto: LogoutDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResult> {
    // No JWT auth needed — possession of the session token authorizes its own revocation.
    if (dto.sessionToken) {
      await this.sessionTokens.revoke(dto.sessionToken);
    }
    this.clearMediaCookie(reply);
    return { code: BusinessCode.OK, message: 'success' };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('auth/logout-all')
  @ApiOperation({ summary: 'Logout all devices (revoke every session)' })
  async logoutAll(
    @Request() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResult> {
    await this.authService.invalidateAllSessions(req.user.userId, 'all_devices');
    this.clearMediaCookie(reply);
    return { code: BusinessCode.OK, message: 'success' };
  }

  @ApiBearerAuth()
  @Throttle(10, 60)
  @HttpCode(HttpStatus.OK)
  @Post('auth/change-password')
  @ApiOperation({ summary: 'Change password (revoke every session — the client re-logs in)' })
  async changePassword(
    @Request() req: FastifyRequest,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResult> {
    const r = await this.authService.changePassword(
      req.user.userId,
      dto.oldPassword,
      dto.newPassword,
    );
    if (r.ok) {
      // Every session (including this device's) is revoked → the media cookie is dead; clear it. The
      // client re-logs in for a fresh session token.
      this.clearMediaCookie(reply);
      return { code: BusinessCode.OK, message: 'success' };
    }
    return { code: BusinessCode.VALIDATION_FAILED, message: 'old password wrong' };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('auth/sessions')
  @ApiOperation({ summary: "List the current user's active sessions" })
  async sessions(@Request() req: FastifyRequest): Promise<ApiResult> {
    return {
      code: BusinessCode.OK,
      message: 'success',
      data: await this.authService.listActiveSessions(
        req.user.userId,
        req.user.sessionId ?? null,
      ),
    };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('auth/revoke-session')
  @ApiOperation({
    summary: 'Revoke a single session by its device-list id (belonging to the current user)',
  })
  async revokeSession(
    @Request() req: FastifyRequest,
    @Body() dto: RevokeSessionDto,
  ): Promise<ApiResult> {
    await this.authService.revokeSession(req.user.userId, dto.id);
    return { code: BusinessCode.OK, message: 'success' };
  }
}
