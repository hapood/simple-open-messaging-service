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
import type { FastifyReply } from 'fastify';
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
  @ApiOperation({ summary: '登录（凭据换 access/refresh token）' })
  // login 凭据由 LocalStrategy 校验；@Body DTO 仅取 device，并经全局 ValidationPipe 白名单。
  @ApiBody({ type: LoginDto })
  async login(
    @Request() req,
    @Body() body: LoginDto,
    @Headers('user-agent') userAgent: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResult> {
    const authInfo: LoginAuthInfo = req.user;
    if (authInfo.status === 0) {
      const tokens = await this.authService.login(authInfo.userId, {
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
          message: 'error username/password',
        };
      }
    }
  }

  @Throttle(30, 60)
  @HttpCode(HttpStatus.OK)
  @Post('auth/renew-access')
  @ApiOperation({
    summary: '用 refresh token 轮换出新的 access + refresh（检测重用即全家族吊销）',
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
      // rotateRefreshToken 失败抛 reason 字符串：reuse → 家族已连根吊销，前端须强制重登；
      // invalid/expired → 普通 401。任一失败都清掉 media cookie（旧 token 已不可用）。
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
    summary: '用 refresh token 轮换出新的 access + refresh（与 renew-access 同义，保留兼容）',
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
  @ApiOperation({ summary: '登出（吊销 refresh；accessJti 可选，即时把当前 access 入黑名单）' })
  async logout(
    @Body() dto: LogoutDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResult> {
    // 前端发 'public' 头 + body，无需 JWT 鉴权，以 refresh token 持有证明吊销。
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
  @ApiOperation({ summary: '全设备登出（吊销所有会话 + bump tokenVersion）' })
  async logoutAll(
    @Request() req,
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
  @ApiOperation({ summary: '修改密码（吊销所有其他会话，当前设备重发 token）' })
  async changePassword(
    @Request() req,
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
  @ApiOperation({ summary: '列当前用户活跃会话' })
  async sessions(@Request() req): Promise<ApiResult> {
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
  @ApiOperation({ summary: '吊销单个会话（按 jti + 属当前用户）' })
  async revokeSession(
    @Request() req,
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
  async issueNotificationToken(@Request() req): Promise<ApiResult> {
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
