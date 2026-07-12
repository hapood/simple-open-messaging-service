import {
  Controller,
  Post,
  Delete,
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
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { AuthService } from '../auth/auth.service.js';
import {
  MEDIA_TOKEN_COOKIE,
  MEDIA_COOKIE_OPTIONS,
} from '../auth/access-token.validator.js';
import { NotificationTokenService } from '../auth/notification-token.service.js';
import { LoginAuthInfo } from '../auth/local.strategy.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
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
    private readonly notificationTokens: NotificationTokenService,
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
      this.setMediaCookie(reply, tokens.access_token);
      return {
        code: BusinessCode.OK,
        message: 'successful',
        data: tokens,
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
          code: BusinessCode.UNAUTHENTICATED,
          message: 'error account/password',
        };
      }
    }
  }

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

  @Throttle(30, 60)
  @HttpCode(HttpStatus.OK)
  @Post('auth/logout')
  @ApiOperation({ summary: 'Logout (revoke the refresh token; accessJti optional — immediately blacklists the current access token)' })
  async logout(
    @Body() dto: LogoutDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResult> {
    // The client sends a 'public' header + body; no JWT auth needed — possession of the refresh
    // token authorizes the revocation.
    await this.authService.logout(dto.refreshToken);
    if (dto.accessJti) {
      await this.authService.blacklistAccessJti(dto.accessJti);
    }
    this.clearMediaCookie(reply);
    return { code: BusinessCode.OK, message: 'success' };
  }

  @UseGuards(JwtAuthGuard)
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

  @UseGuards(JwtAuthGuard)
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

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('auth/sessions')
  @ApiOperation({ summary: "List the current user's active sessions" })
  async sessions(@Request() req: FastifyRequest): Promise<ApiResult> {
    return {
      code: BusinessCode.OK,
      message: 'success',
      data: await this.authService.listActiveSessions(req.user.userId),
    };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('auth/revoke-session')
  @ApiOperation({ summary: 'Revoke a single session (by jti, belonging to the current user)' })
  async revokeSession(
    @Request() req: FastifyRequest,
    @Body() dto: RevokeSessionDto,
  ): Promise<ApiResult> {
    await this.authService.revokeSession(req.user.userId, dto.jti, dto.accessJti);
    return { code: BusinessCode.OK, message: 'success' };
  }

  // ─── Notification token (scoped background-poll credential) ─────────────────────────────────
  // See NotificationTokenService. The Android WorkManager poller presents this Bearer token on
  // /notifications/missed; it is separate from the JWT/refresh-token family so it can't race the
  // web client's renewal and can't be used for anything beyond the missed-thread summary.

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle(10, 60)
  @HttpCode(HttpStatus.OK)
  @Post('auth/notification-token')
  @ApiOperation({ summary: 'Issue a long-lived notification token for the background poller' })
  async issueNotificationToken(@Request() req: FastifyRequest): Promise<ApiResult> {
    const notificationToken = await this.notificationTokens.issue(req.user.userId);
    return { code: BusinessCode.OK, message: 'success', data: { notificationToken } };
  }

  /** Self-revoke: a device presents its own Bearer notification token and the server invalidates
   *  that one token (per-device, not all the user's tokens). No guard needed — possession of the
   *  token IS the proof; a not-found/already-revoked token is an idempotent no-op. Called on logout. */
  @HttpCode(HttpStatus.OK)
  @Delete('auth/notification-token')
  @ApiOperation({ summary: 'Revoke the presented notification token (self-revoke on logout)' })
  async revokeNotificationToken(@Headers('authorization') auth: string): Promise<ApiResult> {
    const match = /^Bearer\s+(.+)$/i.exec(auth ?? '');
    if (match) {
      await this.notificationTokens.revoke(match[1]);
    }
    return { code: BusinessCode.OK, message: 'success' };
  }
}
