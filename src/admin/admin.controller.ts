import {
  Controller,
  Post,
  Body,
  Param,
  Headers,
  Ip,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import {
  AdminLoginDto,
  AdminRefreshDto,
  AdminListUsersDto,
  AdminResetPasswordDto,
  AdminUnbanDto,
  AdminListSessionsDto,
  AdminListPushTokensDto,
  AdminPushTestDto,
} from './admin.dto.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { AuthService } from '../auth/auth.service.js';
import { UserManageService } from '../user-manage/user-manage.service.js';
import { LocalStrategy } from '../auth/local.strategy.js';
import { PrismaService } from '../prisma.service.js';
import { SseService } from '../gateway/sse.service.js';
import { PushService } from '../push/push.service.js';

/**
 * Admin console auth endpoints (Phase A): login / renew-access / logout.
 * Management endpoints (users / force-logout / sessions / bans / reuse, etc.) are added in Phase B,
 * all guarded by AdminAuthGuard under the admin/ prefix.
 */
@ApiTags('admin')
@Controller()
export class AdminController {
  constructor(
    private readonly adminAuthService: AdminAuthService,
    private readonly authService: AuthService,
    private readonly userManageService: UserManageService,
    private readonly localStrategy: LocalStrategy,
    private readonly prisma: PrismaService,
    private readonly sseService: SseService,
    private readonly pushService: PushService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('admin/login')
  @ApiOperation({ summary: 'Admin login (separate admin JWT + family-based refresh)' })
  async login(
    @Body() dto: AdminLoginDto,
    @Headers('user-agent') userAgent: string,
    @Ip() ip: string,
  ): Promise<ApiResult> {
    const r = await this.adminAuthService.login(dto.account, dto.password, ip);
    if (r) return { code: BusinessCode.OK, message: 'success', data: r };
    return { code: BusinessCode.UNAUTHENTICATED, message: 'invalid credentials' };
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
      return {
        code: BusinessCode.OK,
        message: 'success',
        data: { access_token: access, refresh_token: refresh },
      };
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
    return { code: BusinessCode.OK, message: 'success' };
  }

  // ===== User management =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users')
  @ApiOperation({ summary: 'User list (paginated + searchable)' })
  async listUsers(@Body() dto: AdminListUsersDto): Promise<ApiResult> {
    const where = dto.search
      ? { isGroup: false, account: { contains: dto.search, mode: 'insensitive' as const } }
      : { isGroup: false };
    const [list, total] = await Promise.all([
      this.userManageService.getUserList({
        where,
        skip: dto.skip ?? 0,
        take: dto.take ?? 20,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);
    return { code: BusinessCode.OK, message: 'success', data: { list, total } };
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
    return {
      code: BusinessCode.OK,
      message: 'success',
      data: {
        list,
        total,
        fcmConfigured: this.pushService.fcmConfigured,
        webPushConfigured: this.pushService.webPushConfigured,
      },
    };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/push/tokens/:id/delete')
  @ApiOperation({ summary: 'Delete (revoke) a push device token' })
  async deletePushToken(@Param('id') id: string): Promise<ApiResult> {
    await this.pushService.deleteTokenById(Number(id));
    return { code: BusinessCode.OK, message: 'success' };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/push/test')
  @ApiOperation({ summary: 'Send a test push to a given device token (FCM / Web Push)' })
  async sendPushTest(@Body() dto: AdminPushTestDto): Promise<ApiResult> {
    // The push may legitimately fail (transport unconfigured, dead token) — surface that as a normal
    // result (code OK + data.ok=false) rather than an API error, so the admin sees the reason.
    const r = await this.pushService.sendTestPush(dto.id, dto.title, dto.body ?? '');
    return {
      code: BusinessCode.OK,
      message: 'success',
      data: r.ok ? { ok: true } : { ok: false, error: r.error },
    };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/disable')
  @ApiOperation({ summary: 'Disable a user (soft-delete + force logout)' })
  async disableUser(@Param('id') id: string): Promise<ApiResult> {
    await this.prisma.user.update({ where: { id: Number(id) }, data: { isDeleted: true } });
    await this.authService.invalidateAllSessions(Number(id), 'admin_disabled');
    return { code: BusinessCode.OK, message: 'success' };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/enable')
  @ApiOperation({ summary: 'Enable a user' })
  async enableUser(@Param('id') id: string): Promise<ApiResult> {
    await this.prisma.user.update({ where: { id: Number(id) }, data: { isDeleted: false } });
    return { code: BusinessCode.OK, message: 'success' };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/force-logout')
  @ApiOperation({ summary: "Force logout (revoke all of the user's sessions)" })
  async forceLogout(@Param('id') id: string): Promise<ApiResult> {
    await this.authService.invalidateAllSessions(Number(id), 'admin_force_logout');
    return { code: BusinessCode.OK, message: 'success' };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/sessions')
  @ApiOperation({ summary: "View a given user's active sessions" })
  async userSessions(@Param('id') id: string): Promise<ApiResult> {
    return {
      code: BusinessCode.OK,
      message: 'success',
      data: await this.authService.listActiveSessions(Number(id)),
    };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/reset-password')
  @ApiOperation({ summary: "Reset a user's password (revokes all sessions)" })
  async resetPassword(
    @Param('id') id: string,
    @Body() dto: AdminResetPasswordDto,
  ): Promise<ApiResult> {
    const hash = await this.authService.hashStr(dto.newPassword);
    await this.prisma.user.update({ where: { id: Number(id) }, data: { hashPwd: hash } });
    await this.authService.invalidateAllSessions(Number(id), 'admin_reset_password');
    return { code: BusinessCode.OK, message: 'success' };
  }

  // ===== Ban management =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/bans')
  @ApiOperation({ summary: 'List active login bans (IP / account)' })
  async listBans(): Promise<ApiResult> {
    return { code: BusinessCode.OK, message: 'success', data: this.localStrategy.listBans() };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/bans/unban')
  @ApiOperation({ summary: 'Unban (IP and/or account)' })
  async unban(@Body() dto: AdminUnbanDto): Promise<ApiResult> {
    this.localStrategy.clearBan({ ip: dto.ip, account: dto.account });
    return { code: BusinessCode.OK, message: 'success' };
  }

  // ===== Reuse audit =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/reuse-alerts')
  @ApiOperation({ summary: 'Refresh-token reuse alerts (revokeReason=reuse)' })
  async reuseAlerts(@Body() dto: { take?: number }): Promise<ApiResult> {
    const rows = await this.prisma.refreshToken.findMany({
      where: { revokeReason: 'reuse' },
      select: {
        userId: true,
        familyId: true,
        jti: true,
        ip: true,
        userAgent: true,
        revokedAt: true,
      },
      orderBy: { revokedAt: 'desc' },
      take: dto.take ?? 50,
    });
    return { code: BusinessCode.OK, message: 'success', data: rows };
  }

  // ===== System-wide active session overview =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/sessions')
  @ApiOperation({ summary: 'System-wide active session overview (cross-user; filter by userId/ip)' })
  async listAllSessions(@Body() dto: AdminListSessionsDto): Promise<ApiResult> {
    const where = {
      revokedAt: null,
      expiresAt: { gt: new Date() },
      ...(dto.userId ? { userId: dto.userId } : {}),
      ...(dto.ip ? { ip: { contains: dto.ip } } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.refreshToken.findMany({
        where,
        skip: dto.skip ?? 0,
        take: dto.take ?? 50,
        orderBy: { createdAt: 'desc' },
        select: {
          userId: true,
          jti: true,
          device: true,
          userAgent: true,
          ip: true,
          createdAt: true,
          expiresAt: true,
          user: { select: { id: true, account: true } },
        },
      }),
      this.prisma.refreshToken.count({ where }),
    ]);
    return { code: BusinessCode.OK, message: 'success', data: { list, total } };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/sessions/purge')
  @ApiOperation({ summary: 'Purge all active sessions in one shot (forces every user to re-login; access tokens expire immediately)' })
  async purgeAllSessions(): Promise<ApiResult> {
    // Find every user with an active session and invalidateAllSessions for each (bump tokenVersion + revoke refresh).
    const active = await this.prisma.refreshToken.findMany({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
      select: { userId: true },
      distinct: ['userId'],
    });
    for (const { userId } of active) {
      await this.authService.invalidateAllSessions(userId, 'admin_purge');
    }
    return {
      code: BusinessCode.OK,
      message: 'success',
      data: { purgedUsers: active.length },
    };
  }

  // ===== Live connection observability (SSE online stream, in-memory, read-only) =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/connections')
  @ApiOperation({ summary: 'Online SSE connection overview (aggregated per user)' })
  async listConnections(): Promise<ApiResult> {
    const snap = this.sseService.snapshot();
    if (snap.clients.length === 0) {
      return { code: BusinessCode.OK, message: 'success', data: snap };
    }
    // Backfill account names in one batch to avoid N+1.
    const users = await this.prisma.user.findMany({
      where: { id: { in: snap.clients.map((c) => c.userId) } },
      select: { id: true, account: true },
    });
    const nameMap = new Map(users.map((u) => [u.id, u.account]));
    return {
      code: BusinessCode.OK,
      message: 'success',
      data: {
        total: snap.total,
        uniqueUsers: snap.uniqueUsers,
        clients: snap.clients.map((c) => ({
          ...c,
          account: nameMap.get(c.userId) ?? null,
        })),
      },
    };
  }

  // ===== Admin sessions (separate AdminRefreshToken table) =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/admin-sessions')
  @ApiOperation({ summary: 'Admin active session list (joins Admin → linked user account)' })
  async listAdminSessions(@Body() dto: AdminListSessionsDto): Promise<ApiResult> {
    const where = {
      revokedAt: null,
      expiresAt: { gt: new Date() },
      ...(dto.ip ? { ip: { contains: dto.ip } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.adminRefreshToken.findMany({
        where,
        skip: dto.skip ?? 0,
        take: dto.take ?? 50,
        orderBy: { createdAt: 'desc' },
        select: {
          adminId: true,
          jti: true,
          userAgent: true,
          ip: true,
          createdAt: true,
          expiresAt: true,
          admin: { select: { id: true, user: { select: { account: true } } } },
        },
      }),
      this.prisma.adminRefreshToken.count({ where }),
    ]);
    // Flatten admin.user.account → admin.account so the response shape matches the user-session shape.
    const list = rows.map((r) => ({ ...r, admin: { id: r.admin.id, account: r.admin.user.account } }));
    return { code: BusinessCode.OK, message: 'success', data: { list, total } };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/admin-sessions/:jti/revoke')
  @ApiOperation({ summary: 'Revoke a given admin session (by jti; its access token stays valid for up to 15m)' })
  async revokeAdminSession(@Param('jti') jti: string): Promise<ApiResult> {
    await this.prisma.adminRefreshToken.updateMany({
      where: { jti, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'admin_revoke' },
    });
    return { code: BusinessCode.OK, message: 'success' };
  }
}
