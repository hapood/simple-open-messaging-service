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
  MEDIA_TOKEN_COOKIE,
  setSessionCookies,
  clearSessionCookies,
} from '../auth/media-token.js';
import { extractBearer } from '../auth/bearer.js';
import {
  SessionTokenService,
  type SessionClient,
} from '../auth/session-token.service.js';
import { LoginAuthInfo } from '../auth/local.strategy.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { Public, MustChangePasswordEscapeHatch } from '../common/public.decorator.js';
import {
  LoginDto,
  LogoutDto,
  ChangePasswordDto,
  SetPasswordDto,
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

  // Cookie set/clear live in media-token.ts (setSessionCookies / clearSessionCookies) — shared by the
  // password, OTP, and QR login paths so every flow sets the session credential identically.

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
  ) {
    const authInfo = req.user;
    if (authInfo.status === 0) {
      // status 0 (success) implies userId is set — see LocalStrategy.validate. Issue the single
      // long-lived session credential. Lifetime is decided by `trusted` (see SessionTokenService.issue):
      // trusted → permanent (the native app, or an opted-in desktop); untrusted → sliding 14-day.
      const client: SessionClient = body.client ?? 'web';
      const persistent = body.persistent !== false; // default true (14d sliding cookie); false → session cookie
      // Trust gating: the native app is always trusted; a desktop is trusted only on explicit opt-in
      // (it stores the token in OS keyring); web can never be trusted (no OS secure storage for a bearer).
      const trusted = client === 'app' || (client === 'desktop' && body.trusted === true);
      const session_token = await this.sessionTokens.issue(
        authInfo.userId!,
        client,
        { device: body.device, userAgent, ip, persistent, trusted },
      );
      setSessionCookies(reply, session_token, persistent);
      // mustChangePassword flags an admin-generated INITIAL password the user must change before the
      // app is usable — the client forces the set-password screen.
      return {
        session_token,
        ...(authInfo.mustChangePassword ? { mustChangePassword: true } : {}),
      };
    }
    if (authInfo.status === 2) {
      // PASSWORD_NOT_SET: the account has no password (OTP/QR-only). The client shows "contact the
      // administrator to set the initial password". Thrown → AllExceptionsFilter renders HTTP 200 + code.
      throw new BusinessException(BusinessCode.PASSWORD_NOT_SET, 'password not set');
    }
    // status 1: invalid credentials, or banned mid-window. Both are HTTP 200 + business code (the client
    // branches on `code` in its success callback); the global AllExceptionsFilter renders the body.
    if (authInfo.bannedUntil !== undefined) {
      // bannedUntil is a ms-timestamp number (BruteForceService), so throwing it serializes identically to
      // the prior returned envelope — no Date→ISO shift (the filter bypasses serializeBody).
      throw new BusinessException(
        BusinessCode.RATE_LIMITED,
        'too many bad attempts',
        HttpStatus.OK,
        { bannedUntil: authInfo.bannedUntil },
      );
    }
    throw new BusinessException(BusinessCode.INVALID_CREDENTIALS, 'invalid credentials');
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
  ): Promise<void> {
    // @Public (callable even with a dead/expired credential, so logout always clears the cookie).
    // Identify the session from the body, the cookie, OR the Bearer header — in priority order. The Bearer
    // path is what native clients (the Tauri shell's `api_request` IPC injects it from its held token) now
    // use: JS no longer places the token in the body, so the backend resolves it from the header instead.
    // The cookie path covers the pure-httpOnly browser (the token is JS-unreadable there); the body path is
    // retained for any older client still sending it.
    const token =
      dto.sessionToken ??
      req.cookies?.[MEDIA_TOKEN_COOKIE] ??
      extractBearer(req.headers['authorization']);
    if (token) {
      await this.sessionTokens.revoke(token);
    }
    clearSessionCookies(reply);
  }

  @ApiBearerAuth()
  @MustChangePasswordEscapeHatch()
  @HttpCode(HttpStatus.OK)
  @Post('auth/logout-all')
  @ApiOperation({ summary: 'Logout all devices (revoke every session)' })
  async logoutAll(
    @Request() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.authService.invalidateAllSessions(req.user.userId, 'all_devices');
    clearSessionCookies(reply);
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
  ): Promise<void> {
    const r = await this.authService.changePassword(
      req.user.userId,
      dto.oldPassword,
      dto.newPassword,
    );
    if (!r.ok) {
      // Old-password mismatch → HTTP 200 + VALIDATION_FAILED (the global AllExceptionsFilter renders it).
      throw new BusinessException(BusinessCode.VALIDATION_FAILED, 'old password wrong');
    }
    // Every session (including this device's) is revoked → the media cookie is dead; clear it. The
    // client re-logs in for a fresh session token.
    clearSessionCookies(reply);
  }

  @ApiBearerAuth()
  @MustChangePasswordEscapeHatch()
  @Throttle(10, 60)
  @HttpCode(HttpStatus.OK)
  @Post('auth/set-password')
  @ApiOperation({ summary: "Set the user's own password (forced first-time set after an initial password; clears mustChangePassword)" })
  async setPassword(@Request() req: FastifyRequest, @Body() dto: SetPasswordDto): Promise<void> {
    // No old password: the caller is already session-authenticated. Establishes the user's own password and
    // clears the mustChangePassword flag so the app unlocks. Sessions are kept (unlike change-password).
    // sessionId is threaded so setPassword can bust this token's validate cache (the cleared flag must be
    // seen immediately, not after the 60s cache TTL).
    await this.authService.setPassword(req.user.userId, dto.newPassword, req.user.sessionId ?? undefined);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('auth/sessions')
  @ApiOperation({ summary: "List the current user's active sessions" })
  async sessions(@Request() req: FastifyRequest) {
    return this.authService.listActiveSessions(
      req.user.userId,
      req.user.sessionId ?? null,
    );
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
  ): Promise<void> {
    await this.authService.revokeSession(req.user.userId, dto.id);
  }
}
