import { Public } from '../common/public.decorator.js';
import {
  Controller,
  Post,
  Body,
  Param,
  Headers,
  Ip,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { Roles } from './admin-roles.decorator.js';
import { Audit } from './audit.decorator.js';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { AdminRole } from '../database/enums.js';
import {
  AdminLoginDto,
  AdminLoginVerifyDto,
  WebAuthnLoginBeginDto,
  WebAuthnLoginFinishDto,
  AdminListUsersDto,
  AdminUnbanDto,
  AdminListSessionsDto,
  AdminListPushTokensDto,
  AdminPushTestDto,
  AdminUserBatchDto,
  AdminCreateUserDto,
} from './admin.dto.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { PUBLIC_CONFIG, isPasswordLoginEnabled } from '../config/public-config.js';
import { AuthService } from '../auth/auth.service.js';
import { OtpLoginService } from '../auth/otp-login.service.js';
import { BruteForceService } from '../auth/brute-force.service.js';
import { UserManageService } from '../user-manage/user-manage.service.js';
import { SseService } from '../gateway/sse.service.js';
import { PushService } from '../push/push.service.js';
import { ADMIN_SESSION_COOKIE, clearAdminSessionCookie, setAdminSessionCookie } from './admin-session.js';

/**
 * Admin console HTTP adapter. All domain logic lives in services (AdminAuthService, AuthService,
 * UserManageService, BruteForceService, SseService, PushService) — this controller only parses input
 * and delegates. No database is touched here. Handlers return raw data (or void for acks); the global
 * SerializeInterceptor wraps the {code,message,data} envelope. Failures throw BusinessException (the
 * global AllExceptionsFilter renders the body).
 *
 * RBAC (Phase 1): read/list endpoints carry no @Roles (open to every admin role, incl. VIEWER);
 * routine mutations require ADMIN+; the only SUPER_ADMIN-only operation is purge-all. Every mutation is
 * tagged @Audit → AdminAuditInterceptor writes an AdminActionLog row.
 */
@ApiTags('admin')
@Public()
@Controller()
export class AdminController {
  constructor(
    private readonly adminAuthService: AdminAuthService,
    private readonly authService: AuthService,
    private readonly userManageService: UserManageService,
    private readonly bruteForce: BruteForceService,
    private readonly sseService: SseService,
    private readonly pushService: PushService,
    private readonly otpLoginService: OtpLoginService,
  ) {}

  @UseGuards(ThrottleGuard)
  @Throttle(5, 60) // 5 attempts/min per IP — brute-force ceiling over the account-dim progressive ban + argon2
  @HttpCode(HttpStatus.OK)
  @Post('admin/login')
  @ApiOperation({ summary: 'Admin login (password → session, or 2FA challenge when enrolled)' })
  async login(
    @Body() dto: AdminLoginDto,
    @Headers('user-agent') userAgent: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // Throws BusinessException(INVALID_CREDENTIALS | RATE_LIMITED) on failure — the global filter renders it.
    // On success sets the httpOnly admin_session cookie and returns { authenticated: true };
    // otherwise a { twoFactorRequired, challengeToken, factors } challenge.
    const result = await this.adminAuthService.login(dto.account, dto.password, ip, userAgent);
    if ('sessionToken' in result) {
      setAdminSessionCookie(reply, result.sessionToken);
      return { authenticated: true };
    }
    return result;
  }

  @UseGuards(ThrottleGuard)
  @Throttle(5, 60) // per-IP ceiling on the 6-digit guess; the account-dim progressive ban lives in the service
  @HttpCode(HttpStatus.OK)
  @Post('admin/login/verify')
  @ApiOperation({ summary: 'Admin 2FA login verify (TOTP or backup code) → session' })
  async loginVerify(
    @Body() dto: AdminLoginVerifyDto,
    @Headers('user-agent') userAgent: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.adminAuthService.verifyLogin(
      dto.challengeToken, dto.code, dto.backupCode, ip, userAgent,
    );
    setAdminSessionCookie(reply, result.sessionToken);
    return { authenticated: true };
  }

  @UseGuards(ThrottleGuard)
  @Throttle(5, 60) // per-IP ceiling; the account-dim 2FA progressive ban lives in the service
  @HttpCode(HttpStatus.OK)
  @Post('admin/webauthn/login/begin')
  @ApiOperation({ summary: 'Admin passkey login begin (challenge token → assertion options)' })
  async webauthnLoginBegin(@Body() dto: WebAuthnLoginBeginDto) {
    return this.adminAuthService.beginWebAuthnLogin(dto.challengeToken);
  }

  @UseGuards(ThrottleGuard)
  @Throttle(5, 60)
  @HttpCode(HttpStatus.OK)
  @Post('admin/webauthn/login/finish')
  @ApiOperation({ summary: 'Admin passkey login finish (assertion) → session' })
  async webauthnLoginFinish(
    @Body() dto: WebAuthnLoginFinishDto,
    @Headers('user-agent') userAgent: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.adminAuthService.verifyWebAuthnLogin(
        dto.challengeToken,
        dto.pendingToken,
        dto.assertionResponse,
        ip,
        userAgent,
      );
    setAdminSessionCookie(reply, result.sessionToken);
    return { authenticated: true };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/logout')
  @ApiOperation({ summary: 'Admin logout' })
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    const token = req.cookies?.[ADMIN_SESSION_COOKIE];
    if (token) await this.adminAuthService.revokeAdminSessionToken(token);
    clearAdminSessionCookie(reply);
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/me')
  @ApiOperation({ summary: 'Current admin identity (account + role) for the console header + role gating' })
  async me(@Req() req: FastifyRequest) {
    const adminId = (req.user as { adminId?: number } | undefined)?.adminId;
    // Defense-in-depth: AdminAuthGuard already guarantees adminId for a non-@Public route. Thrown as
    // HTTP 200 + UNAUTHENTICATED (the prior wire) — the global AllExceptionsFilter renders the body.
    if (!adminId) throw new BusinessException(BusinessCode.UNAUTHENTICATED, 'no admin session');
    const me = await this.adminAuthService.me(adminId);
    if (!me) throw new BusinessException(BusinessCode.UNAUTHENTICATED, 'no admin profile');
    return me;
  }

  // ===== User management =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users')
  @ApiOperation({ summary: 'User list (paginated + searchable)' })
  async listUsers(@Body() dto: AdminListUsersDto) {
    return this.userManageService.listUsers(dto);
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('user.create', { targetType: 'user' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/create')
  @ApiOperation({ summary: 'Create a user account (admin-provisioned)' })
  async createUser(@Body() dto: AdminCreateUserDto) {
    // loginMode policy: a password is required iff password login is the active method (ALL / PASSWORD_ONLY).
    // In APP_OTP_AND_QR the account has no password — it bootstraps via the one-time code issued next.
    if (isPasswordLoginEnabled(PUBLIC_CONFIG.loginMode) && !dto.password) {
      throw new BusinessException(BusinessCode.VALIDATION_FAILED, 'password is required', HttpStatus.BAD_REQUEST);
    }
    return this.userManageService.createUser({
      account: dto.account,
      name: dto.name,
      password: dto.password,
    });
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('user.issue_login_code', { targetType: 'user', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/issue-login-code')
  @ApiOperation({ summary: 'Issue a one-time login code for a user (plaintext returned once)' })
  async issueLoginCode(@Req() req: FastifyRequest, @Param('id') id: string) {
    const adminId = (req.user as { adminId?: number } | undefined)?.adminId;
    if (!adminId) throw new BusinessException(BusinessCode.UNAUTHENTICATED, 'no admin session');
    return this.otpLoginService.issueCode(adminId, Number(id));
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/login-codes')
  @ApiOperation({ summary: "Audit list of a user's one-time login codes (never the code/token value)" })
  async listLoginCodes(@Param('id') id: string) {
    return this.otpLoginService.listCodes(Number(id));
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('user.revoke_login_code', { targetType: 'login_code', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/login-codes/:id/revoke')
  @ApiOperation({ summary: 'Revoke an unused one-time login code' })
  async revokeLoginCode(@Param('id') id: string): Promise<void> {
    await this.otpLoginService.revokeCode(Number(id));
  }

  // ===== Push management (FCM / device tokens) =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/push/tokens')
  @ApiOperation({ summary: 'Push device-token list (paginated + searchable) + FCM/Web Push config status' })
  async listPushTokens(@Body() dto: AdminListPushTokensDto) {
    const { list, total } = await this.pushService.listTokens({
      skip: dto.skip ?? 0,
      take: dto.take ?? 20,
      search: dto.search,
    });
    return {
      list,
      total,
      fcmConfigured: this.pushService.fcmConfigured,
      webPushConfigured: this.pushService.webPushConfigured,
    };
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('push.token.delete', { targetType: 'push_token', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/push/tokens/:id/delete')
  @ApiOperation({ summary: 'Delete (revoke) a push device token' })
  async deletePushToken(@Param('id') id: string): Promise<void> {
    await this.pushService.deleteTokenById(Number(id));
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('push.test', { targetType: 'push_token', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/push/test')
  @ApiOperation({ summary: 'Send a test push to a given device token (FCM / Web Push)' })
  async sendPushTest(@Body() dto: AdminPushTestDto) {
    // The push may legitimately fail (transport unconfigured, dead token) — surface that as a normal
    // result (code OK + data.ok=false) rather than an API error, so the admin sees the reason.
    const r = await this.pushService.sendTestPush(dto.id, dto.title, dto.body ?? '');
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('user.disable', { targetType: 'user', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/disable')
  @ApiOperation({ summary: 'Disable a user (soft-delete + force logout)' })
  async disableUser(@Param('id') id: string): Promise<void> {
    await this.userManageService.disableUser(Number(id));
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('user.enable', { targetType: 'user', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/enable')
  @ApiOperation({ summary: 'Enable a user' })
  async enableUser(@Param('id') id: string): Promise<void> {
    await this.userManageService.enableUser(Number(id));
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('user.force_logout', { targetType: 'user', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/force-logout')
  @ApiOperation({ summary: "Force logout (revoke all of the user's sessions)" })
  async forceLogout(@Param('id') id: string): Promise<void> {
    await this.userManageService.forceLogout(Number(id));
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/sessions')
  @ApiOperation({ summary: "View a given user's active sessions" })
  async userSessions(@Param('id') id: string) {
    // Admin viewing another user's sessions — there is no "current" session from the admin's
    // perspective, so currentSessionId is null (no row is flagged isCurrent).
    return this.authService.listActiveSessions(Number(id), null);
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/detail')
  @ApiOperation({ summary: 'User 360° detail: profile + groups + sessions + push tokens' })
  async userDetail(@Param('id') id: string) {
    const data = await this.userManageService.getUserDetail(Number(id));
    if (!data) throw new BusinessException(BusinessCode.NOT_FOUND, 'user not found');
    return data;
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('user.generate_initial_password', { targetType: 'user', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/generate-initial-password')
  @ApiOperation({ summary: "(Re-)generate the user's initial password (random, reveal-once; forces a set on next login)" })
  async generateInitialPassword(@Param('id') id: string) {
    // The admin can never choose or change a user's password — only (re-)initialize it (server-generated).
    // Refuse outright when password login isn't enabled: no point minting a password that can't be used.
    if (!isPasswordLoginEnabled(PUBLIC_CONFIG.loginMode)) {
      throw new BusinessException(BusinessCode.LOGIN_METHOD_DISABLED, 'password login is disabled');
    }
    return this.userManageService.generateInitialPassword(Number(id));
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('user.batch', { targetType: 'user' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/batch')
  @ApiOperation({ summary: 'Apply an action to many users at once (disable / enable / force-logout)' })
  async batchUsers(@Body() dto: AdminUserBatchDto) {
    // Each id goes through the same path as its single-user counterpart, so disable still
    // force-logs-out, etc. One summary audit row is written by the interceptor (per-user state
    // changes are visible in the list + each user's own session-revocation side effects).
    return this.userManageService.batchUsers(dto.ids, dto.action);
  }

  // ===== Ban management =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/bans')
  @ApiOperation({ summary: 'List active login bans (IP / account — password + OTP)' })
  async listBans() {
    return this.bruteForce.listBans();
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('ban.unban')
  @HttpCode(HttpStatus.OK)
  @Post('admin/bans/unban')
  @ApiOperation({ summary: 'Unban (IP and/or account — clears every account-keyed dimension: password + OTP)' })
  async unban(@Body() dto: AdminUnbanDto): Promise<void> {
    this.bruteForce.unban({ ip: dto.ip, account: dto.account });
  }

  // ===== System-wide active session overview =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/sessions')
  @ApiOperation({ summary: 'System-wide active session overview (cross-user; filter by userId/ip)' })
  async listAllSessions(@Body() dto: AdminListSessionsDto) {
    return this.authService.listAllSessions(dto);
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('session.purge_all')
  @HttpCode(HttpStatus.OK)
  @Post('admin/sessions/purge')
  @ApiOperation({ summary: 'Purge all active sessions in one shot (forces every user to re-login; access tokens expire immediately)' })
  async purgeAllSessions() {
    return this.authService.purgeAllSessions();
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('session.revoke', { targetType: 'user_session', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/sessions/:id/revoke')
  @ApiOperation({ summary: 'Revoke a single active user session (kicks only that device; the user stays online on every other device)' })
  async revokeSession(@Param('id') id: string): Promise<void> {
    // Surgical counterpart to force-logout: only the picked device is force-logged-out; the user's other
    // sessions are untouched. Idempotent — a not-found / already-revoked id surfaces as NOT_FOUND so a
    // stale list row doesn't masquerade as a successful revoke.
    const ok = await this.authService.revokeSessionAdmin(Number(id));
    if (!ok) throw new BusinessException(BusinessCode.NOT_FOUND, 'session not found or already revoked');
  }

  // ===== Live connection observability (SSE online stream, in-memory, read-only) =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/connections')
  @ApiOperation({ summary: 'Online SSE connection overview (aggregated per user)' })
  async listConnections() {
    const snap = this.sseService.snapshot();
    if (snap.clients.length === 0) {
      return snap;
    }
    // Backfill account names in one batch to avoid N+1.
    const nameMap = await this.userManageService.attachAccounts(
      snap.clients.map((c) => c.userId),
    );
    return {
      total: snap.total,
      uniqueUsers: snap.uniqueUsers,
      clients: snap.clients.map((c) => ({ ...c, account: nameMap.get(c.userId) ?? null })),
    };
  }

  // ===== Admin sessions (separate AdminRefreshToken table) =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/admin-sessions')
  @ApiOperation({ summary: 'Admin active session list (joins Admin → linked user account)' })
  async listAdminSessions(@Body() dto: AdminListSessionsDto) {
    return this.adminAuthService.listAdminSessions(dto);
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('admin_session.revoke', { targetType: 'admin_session', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/admin-sessions/:id/revoke')
  @ApiOperation({ summary: 'Revoke an opaque admin session immediately' })
  async revokeAdminSession(@Param('id') id: string): Promise<void> {
    await this.adminAuthService.revokeAdminSession(id);
  }
}
