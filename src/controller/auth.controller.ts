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
import { PasswordLoginEnabledGuard } from '../auth/password-login-enabled.guard.js';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { AuthService } from '../auth/auth.service.js';
import {
  LOGGED_IN_COOKIE,
  LOGGED_IN_COOKIE_OPTIONS,
  MEDIA_COOKIE_OPTIONS,
  MEDIA_TOKEN_COOKIE,
} from '../auth/media-token.js';
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

  /** Set the session credential: the httpOnly `media_token` cookie (the primary credential the global
   *  guard accepts on every route) AND the non-httpOnly `logged_in` presence cookie (so the pure-httpOnly
   *  browser client can read login state via `document.cookie`). `persistent` selects a 14-day cookie
   *  (default, "keep me logged in") vs a session cookie (dropped on browser close). Same validation path
   *  as the API (BearerAuthService) → a revoked session loses all access. */
  private setMediaCookie(reply: FastifyReply, token: string, persistent: boolean) {
    const mediaOpts = persistent
      ? MEDIA_COOKIE_OPTIONS
      : { ...MEDIA_COOKIE_OPTIONS, maxAge: undefined };
    const presenceOpts = persistent
      ? LOGGED_IN_COOKIE_OPTIONS
      : { ...LOGGED_IN_COOKIE_OPTIONS, maxAge: undefined };
    reply.setCookie(MEDIA_TOKEN_COOKIE, token, mediaOpts);
    reply.setCookie(LOGGED_IN_COOKIE, '1', presenceOpts);
  }

  /** Clear both cookies — path must match the one used at set time for the browser to drop them. */
  private clearMediaCookie(reply: FastifyReply) {
    reply.clearCookie(MEDIA_TOKEN_COOKIE, { path: '/' });
    reply.clearCookie(LOGGED_IN_COOKIE, { path: '/' });
  }

  @Public()
  @UseGuards(PasswordLoginEnabledGuard, LocalAuthGuard)
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
      // 'desktop' → sliding 14-day.
      const client: SessionClient = body.client ?? 'web';
      const persistent = body.persistent !== false; // default true (14d sliding cookie); false → session cookie
      const session_token = await this.sessionTokens.issue(
        authInfo.userId!,
        client,
        { device: body.device, userAgent, ip, persistent },
      );
      this.setMediaCookie(reply, session_token, persistent);
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
    @Request() req: FastifyRequest,
    @Body() dto: LogoutDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResult> {
    // @Public (callable even with a dead/expired credential, so logout always clears the cookie).
    // Identify the session from the body (native holds the raw token) OR the cookie (browser pure
    // httpOnly — the token is JS-unreadable, so it can't be placed in the body).
    const token = dto.sessionToken ?? req.cookies?.[MEDIA_TOKEN_COOKIE];
    if (token) {
      await this.sessionTokens.revoke(token);
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
