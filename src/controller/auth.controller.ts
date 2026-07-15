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
import {
  MEDIA_TOKEN_COOKIE,
  MEDIA_COOKIE_OPTIONS,
} from '../auth/access-token.validator.js';
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
  RefreshTokenDto,
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

  /**
   * Mirror the access token into an httpOnly `media_token` cookie so same-origin /uploads/*
   * requests (native <img>/<a download>, which can't send the Authorization header) are
   * authenticated. Set wherever an access token is minted/rotated; cleared on logout. Same
   * validation path as the API (AccessTokenValidator) → revoked tokens lose media access too.
   */
  private setMediaCookie(reply: FastifyReply, accessToken: string) {
    reply.setCookie(MEDIA_TOKEN_COOKIE, accessToken, MEDIA_COOKIE_OPTIONS);
  }

  /** Clear the media cookie — path must match the one used at set time for the browser to drop it. */
  private clearMediaCookie(reply: FastifyReply) {
    reply.clearCookie(MEDIA_TOKEN_COOKIE, { path: '/' });
  }

  @Public()
  @UseGuards(LocalAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('auth/login')
  @ApiOperation({ summary: 'Login (exchange credentials for an access/refresh token pair)' })
  // Login credentials are verified by LocalStrategy; the @Body DTO only consumes `device`, and is
  // whitelisted through the global ValidationPipe.
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
      // status 0 (success) implies userId is set — see LocalStrategy.validate.
      const tokens = await this.authService.login(authInfo.userId!, {
        device: body.device,
        userAgent,
        ip,
      });
      // Issue the long-lived session credential alongside the legacy access/refresh pair (additive —
      // clients that don't consume it yet simply ignore the field). 'app' → no-expiry (native, stored
      // in OS secure storage); 'web' (default) → sliding 30-day.
      const client: SessionClient = body.client ?? 'web';
      const session_token = await this.sessionTokens.issue(
        authInfo.userId!,
        client,
        { device: body.device, userAgent, ip },
      );
      // The httpOnly media cookie mirrors the bearer credential the same-origin /uploads/* preHandler
      // validates (AccessTokenValidator resolves access-JWT OR session token). Mirror the SESSION token
      // (long-lived, sliding) — not the 15-min access token — so browser media stays authenticated
      // without a renew cycle. (Legacy renew-access still mirrors the access token for old clients.)
      this.setMediaCookie(reply, session_token);
      return {
        code: BusinessCode.OK,
        message: 'successful',
        data: { ...tokens, session_token },
      };
    } else {
      if (authInfo.bannedUntil !== undefined) {
        return {
          code: BusinessCode.RATE_LIMITED,
          message: 'too many bad attempts',
          data: {
            bannedUntil: authInfo.bannedUntil,
          },
        };
      } else {
        return {
          code: BusinessCode.INVALID_CREDENTIALS,
          message: 'invalid credentials',
        };
      }
    }
  }

  @Public()
  @Throttle(30, 60)
  @HttpCode(HttpStatus.OK)
  @Post('auth/renew-access')
  @ApiOperation({
    summary: 'Rotate a fresh access + refresh token pair from the refresh token (reuse detection revokes the entire family)',
  })
  async renewaccessTokens(
    @Body() dto: RefreshTokenDto,
    @Headers('user-agent') userAgent: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResult<{ access_token: string; refresh_token: string }>> {
    try {
      const { access, refresh } = await this.authService.rotateRefreshToken(
        dto.refreshToken,
        { device: dto.device, userAgent, ip },
      );
      this.setMediaCookie(reply, access);
      return {
        code: BusinessCode.OK,
        message: 'success',
        data: { access_token: access, refresh_token: refresh },
      };
    } catch (e) {
      // rotateRefreshToken throws a reason string on failure: reuse → the whole family is revoked
      // root-and-branch and the client must force a re-login; invalid/expired → a plain 401. Either
      // failure also clears the media cookie (the old token is no longer usable).
      this.clearMediaCookie(reply);
      if (e === 'reuse') {
        return {
          code: BusinessCode.REFRESH_REUSE_DETECTED,
          message: 'refresh token reuse detected',
        };
      }
      return { code: BusinessCode.UNAUTHENTICATED, message: 'refresh_token is invalid' };
    }
  }

  @Public()
  @Throttle(30, 60)
  @HttpCode(HttpStatus.OK)
  @Post('auth/renew-refresh')
  @ApiOperation({
    summary: 'Rotate a fresh access + refresh token pair from the refresh token (synonym of renew-access, kept for compatibility)',
  })
  async renewRefreshTokens(
    @Body() dto: RefreshTokenDto,
    @Headers('user-agent') userAgent: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResult<{ access_token: string; refresh_token: string }>> {
    try {
      const { access, refresh } = await this.authService.rotateRefreshToken(
        dto.refreshToken,
        { device: dto.device, userAgent, ip },
      );
      this.setMediaCookie(reply, access);
      return {
        code: BusinessCode.OK,
        message: 'success',
        data: { access_token: access, refresh_token: refresh },
      };
    } catch (e) {
      // Any failure (reuse / invalid / expired) means the old access token is no longer usable —
      // clear the media cookie so stale media requests don't keep a dead session visually alive.
      this.clearMediaCookie(reply);
      if (e === 'reuse') {
        return {
          code: BusinessCode.REFRESH_REUSE_DETECTED,
          message: 'refresh token reuse detected',
        };
      }
      return { code: BusinessCode.UNAUTHENTICATED, message: 'refresh_token is invalid' };
    }
  }

  @Public()
  @Throttle(30, 60)
  @HttpCode(HttpStatus.OK)
  @Post('auth/logout')
  @ApiOperation({ summary: 'Logout (revoke the refresh token; accessJti optional — immediately blacklists the current access token)' })
  async logout(
    @Body() dto: LogoutDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResult> {
    // No JWT auth needed — possession of the refresh token (legacy) or the session token authorizes the
    // revocation. The session-token client revokes via sessionToken (below); a legacy client still sends
    // its refresh token. refreshToken is optional now, so guard the legacy revoke path.
    if (dto.refreshToken) {
      await this.authService.logout(dto.refreshToken);
    }
    if (dto.accessJti) {
      await this.authService.blacklistAccessJti(dto.accessJti);
    }
    if (dto.sessionToken) {
      await this.sessionTokens.revoke(dto.sessionToken);
    }
    this.clearMediaCookie(reply);
    return { code: BusinessCode.OK, message: 'success' };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('auth/logout-all')
  @ApiOperation({ summary: 'Logout all devices (revoke every session + bump tokenVersion)' })
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
  @ApiOperation({ summary: 'Change password (revoke all other sessions; reissue tokens for the current device)' })
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
      // changePassword bumps tokenVersion (revoking all other sessions) and reissues a fresh
      // token pair for this device; mirror the new access token into the media cookie.
      this.setMediaCookie(reply, r.access_token);
      return {
        code: BusinessCode.OK,
        message: 'success',
        data: { access_token: r.access_token, refresh_token: r.refresh_token },
      };
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
