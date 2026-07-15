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
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { Roles } from './admin-roles.decorator.js';
import { Audit } from './audit.decorator.js';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { AdminRole } from '../prisma/generated/client.js';
import {
  AdminLoginDto,
  AdminRefreshDto,
  AdminListUsersDto,
  AdminResetPasswordDto,
  AdminUnbanDto,
  AdminListSessionsDto,
  AdminListPushTokensDto,
  AdminPushTestDto,
  AdminUserBatchDto,
} from './admin.dto.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { AuthService } from '../auth/auth.service.js';
import { UserManageService } from '../user-manage/user-manage.service.js';
import { LocalStrategy } from '../auth/local.strategy.js';
import { SseService } from '../gateway/sse.service.js';
import { PushService } from '../push/push.service.js';

/**
 * Admin console HTTP adapter. All domain logic lives in services (AdminAuthService, AuthService,
 * UserManageService, LocalStrategy, SseService, PushService) — this controller only parses input,
 * delegates, and wraps the {code,message,data} envelope. No Prisma is touched here.
 *
 * RBAC (Phase 1): read/list endpoints carry no @Roles (open to every admin role, incl. VIEWER);
 * routine mutations require ADMIN+; high-impact operations (reset-password, purge-all) require
 * SUPER_ADMIN. Every mutation is tagged @Audit → AdminAuditInterceptor writes an AdminActionLog row.
 */
@ApiTags('admin')
@Public()
@Controller()
export class AdminController {
  constructor(
    private readonly adminAuthService: AdminAuthService,
    private readonly authService: AuthService,
    private readonly userManageService: UserManageService,
    private readonly localStrategy: LocalStrategy,
    private readonly sseService: SseService,
    private readonly pushService: PushService,
  ) {}

  private ok(data?: unknown): ApiResult {
    return data === undefined
      ? { code: BusinessCode.OK, message: 'success' }
      : { code: BusinessCode.OK, message: 'success', data };
  }

  @UseGuards(ThrottleGuard)
  @Throttle(5, 60) // 5 attempts/min per IP — brute-force ceiling on top of argon2's slow hash
  @HttpCode(HttpStatus.OK)
  @Post('admin/login')
  @ApiOperation({ summary: 'Admin login (separate admin JWT + family-based refresh)' })
  async login(
    @Body() dto: AdminLoginDto,
    @Headers('user-agent') _userAgent: string,
    @Ip() ip: string,
  ): Promise<ApiResult> {
    const r = await this.adminAuthService.login(dto.account, dto.password, ip);
    if (r) return this.ok(r);
    return { code: BusinessCode.INVALID_CREDENTIALS, message: 'invalid credentials' };
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/renew-access')
  @ApiOperation({ summary: 'Admin refresh rotation (family-based + reuse detection)' })
  async renewAccess(
    @Body() dto: AdminRefreshDto,
    @Headers('user-agent') userAgent: string,
    @Ip() ip: string,
  ): Promise<ApiResult> {
    try {
      const { access, refresh } = await this.adminAuthService.rotateAdminRefreshToken(
        dto.refreshToken,
        { ip, userAgent },
      );
      return this.ok({ access_token: access, refresh_token: refresh });
    } catch (e) {
      if (e === 'reuse') {
        return { code: BusinessCode.REFRESH_REUSE_DETECTED, message: 'refresh reuse detected' };
      }
      return { code: BusinessCode.UNAUTHENTICATED, message: 'refresh_token invalid' };
    }
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/logout')
  @ApiOperation({ summary: 'Admin logout' })
  async logout(@Body() dto: AdminRefreshDto): Promise<ApiResult> {
    await this.adminAuthService.revokeAdminRefreshToken(dto.refreshToken);
    return this.ok();
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/me')
  @ApiOperation({ summary: 'Current admin identity (account + role) for the console header + role gating' })
  async me(@Req() req: FastifyRequest): Promise<ApiResult> {
    const adminId = (req.user as { adminId?: number } | undefined)?.adminId;
    if (!adminId) return { code: BusinessCode.UNAUTHENTICATED, message: 'no admin session' };
    const me = await this.adminAuthService.me(adminId);
    if (!me) return { code: BusinessCode.UNAUTHENTICATED, message: 'no admin profile' };
    return this.ok(me);
  }

  // ===== User management =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users')
  @ApiOperation({ summary: 'User list (paginated + searchable)' })
  async listUsers(@Body() dto: AdminListUsersDto): Promise<ApiResult> {
    return this.ok(await this.userManageService.listUsers(dto));
  }

  // ===== Push management (FCM / device tokens) =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/push/tokens')
  @ApiOperation({ summary: 'Push device-token list (paginated + searchable) + FCM/Web Push config status' })
  async listPushTokens(@Body() dto: AdminListPushTokensDto): Promise<ApiResult> {
    const { list, total } = await this.pushService.listTokens({
      skip: dto.skip ?? 0,
      take: dto.take ?? 20,
      search: dto.search,
    });
    return this.ok({
      list,
      total,
      fcmConfigured: this.pushService.fcmConfigured,
      webPushConfigured: this.pushService.webPushConfigured,
    });
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('push.token.delete', { targetType: 'push_token', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/push/tokens/:id/delete')
  @ApiOperation({ summary: 'Delete (revoke) a push device token' })
  async deletePushToken(@Param('id') id: string): Promise<ApiResult> {
    await this.pushService.deleteTokenById(Number(id));
    return this.ok();
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('push.test', { targetType: 'push_token', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/push/test')
  @ApiOperation({ summary: 'Send a test push to a given device token (FCM / Web Push)' })
  async sendPushTest(@Body() dto: AdminPushTestDto): Promise<ApiResult> {
    // The push may legitimately fail (transport unconfigured, dead token) — surface that as a normal
    // result (code OK + data.ok=false) rather than an API error, so the admin sees the reason.
    const r = await this.pushService.sendTestPush(dto.id, dto.title, dto.body ?? '');
    return this.ok(r.ok ? { ok: true } : { ok: false, error: r.error });
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('user.disable', { targetType: 'user', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/disable')
  @ApiOperation({ summary: 'Disable a user (soft-delete + force logout)' })
  async disableUser(@Param('id') id: string): Promise<ApiResult> {
    await this.userManageService.disableUser(Number(id));
    return this.ok();
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('user.enable', { targetType: 'user', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/enable')
  @ApiOperation({ summary: 'Enable a user' })
  async enableUser(@Param('id') id: string): Promise<ApiResult> {
    await this.userManageService.enableUser(Number(id));
    return this.ok();
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('user.force_logout', { targetType: 'user', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/force-logout')
  @ApiOperation({ summary: "Force logout (revoke all of the user's sessions)" })
  async forceLogout(@Param('id') id: string): Promise<ApiResult> {
    await this.userManageService.forceLogout(Number(id));
    return this.ok();
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/sessions')
  @ApiOperation({ summary: "View a given user's active sessions" })
  async userSessions(@Param('id') id: string): Promise<ApiResult> {
    // Admin viewing another user's sessions — there is no "current" session from the admin's
    // perspective, so currentSessionId is null (no row is flagged isCurrent).
    return this.ok(await this.authService.listActiveSessions(Number(id), null));
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/detail')
  @ApiOperation({ summary: 'User 360° detail: profile + groups + sessions + push tokens' })
  async userDetail(@Param('id') id: string): Promise<ApiResult> {
    const data = await this.userManageService.getUserDetail(Number(id));
    if (!data) return { code: BusinessCode.NOT_FOUND, message: 'user not found' };
    return this.ok(data);
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('user.reset_password', { targetType: 'user', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/reset-password')
  @ApiOperation({ summary: "Reset a user's password (revokes all sessions)" })
  async resetPassword(
    @Param('id') id: string,
    @Body() dto: AdminResetPasswordDto,
  ): Promise<ApiResult> {
    await this.userManageService.resetPassword(Number(id), dto.newPassword);
    return this.ok();
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('user.batch', { targetType: 'user' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/batch')
  @ApiOperation({ summary: 'Apply an action to many users at once (disable / enable / force-logout)' })
  async batchUsers(@Body() dto: AdminUserBatchDto): Promise<ApiResult> {
    // Each id goes through the same path as its single-user counterpart, so disable still
    // force-logs-out, etc. One summary audit row is written by the interceptor (per-user state
    // changes are visible in the list + each user's own session-revocation side effects).
    return this.ok(await this.userManageService.batchUsers(dto.ids, dto.action));
  }

  // ===== Ban management =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/bans')
  @ApiOperation({ summary: 'List active login bans (IP / account)' })
  async listBans(): Promise<ApiResult> {
    return this.ok(this.localStrategy.listBans());
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('ban.unban')
  @HttpCode(HttpStatus.OK)
  @Post('admin/bans/unban')
  @ApiOperation({ summary: 'Unban (IP and/or account)' })
  async unban(@Body() dto: AdminUnbanDto): Promise<ApiResult> {
    this.localStrategy.clearBan({ ip: dto.ip, account: dto.account });
    return this.ok();
  }

  // ===== Reuse audit =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/reuse-alerts')
  @ApiOperation({ summary: 'Refresh-token reuse alerts (revokeReason=reuse)' })
  async reuseAlerts(@Body() dto: { take?: number }): Promise<ApiResult> {
    return this.ok(await this.authService.reuseAlerts(dto.take));
  }

  // ===== System-wide active session overview =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/sessions')
  @ApiOperation({ summary: 'System-wide active session overview (cross-user; filter by userId/ip)' })
  async listAllSessions(@Body() dto: AdminListSessionsDto): Promise<ApiResult> {
    return this.ok(await this.authService.listAllSessions(dto));
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('session.purge_all')
  @HttpCode(HttpStatus.OK)
  @Post('admin/sessions/purge')
  @ApiOperation({ summary: 'Purge all active sessions in one shot (forces every user to re-login; access tokens expire immediately)' })
  async purgeAllSessions(): Promise<ApiResult> {
    return this.ok(await this.authService.purgeAllSessions());
  }

  // ===== Live connection observability (SSE online stream, in-memory, read-only) =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/connections')
  @ApiOperation({ summary: 'Online SSE connection overview (aggregated per user)' })
  async listConnections(): Promise<ApiResult> {
    const snap = this.sseService.snapshot();
    if (snap.clients.length === 0) {
      return this.ok(snap);
    }
    // Backfill account names in one batch to avoid N+1.
    const nameMap = await this.userManageService.attachAccounts(
      snap.clients.map((c) => c.userId),
    );
    return this.ok({
      total: snap.total,
      uniqueUsers: snap.uniqueUsers,
      clients: snap.clients.map((c) => ({ ...c, account: nameMap.get(c.userId) ?? null })),
    });
  }

  // ===== Admin sessions (separate AdminRefreshToken table) =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/admin-sessions')
  @ApiOperation({ summary: 'Admin active session list (joins Admin → linked user account)' })
  async listAdminSessions(@Body() dto: AdminListSessionsDto): Promise<ApiResult> {
    return this.ok(await this.adminAuthService.listAdminSessions(dto));
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('admin_session.revoke', { targetType: 'admin_session', targetParam: 'jti' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/admin-sessions/:jti/revoke')
  @ApiOperation({ summary: 'Revoke a given admin session (by jti; its access token stays valid for up to 15m)' })
  async revokeAdminSession(@Param('jti') jti: string): Promise<ApiResult> {
    await this.adminAuthService.revokeAdminSession(jti);
    return this.ok();
  }
}
