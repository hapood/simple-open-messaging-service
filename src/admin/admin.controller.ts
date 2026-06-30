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
import { AdminAuthService } from './admin-auth.service';
import { AdminAuthGuard } from './admin-auth.guard';
import {
  AdminLoginDto,
  AdminRefreshDto,
  AdminListUsersDto,
  AdminResetPasswordDto,
  AdminUnbanDto,
  AdminListSessionsDto,
} from './admin.dto';
import { ApiResult } from '../common/api-result';
import { BusinessCode } from '../common/business-code';
import { AuthService } from '../auth/auth.service';
import { UserManageService } from '../user-manage/user-manage.service';
import { LocalStrategy } from '../auth/local.strategy';
import { PrismaService } from '../prisma.service';
import { SseService } from '../gateway/sse.service';

/**
 * Admin 控制台鉴权端点（Phase A）：login / renew-access / logout。
 * 管理端点（用户/force-logout/sessions/bans/reuse 等）在 Phase B 加，统一挂 AdminAuthGuard + admin/ 前缀。
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
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('admin/login')
  @ApiOperation({ summary: '管理员登录（独立 admin JWT + 家族化 refresh）' })
  async login(
    @Body() dto: AdminLoginDto,
    @Headers('user-agent') userAgent: string,
    @Ip() ip: string,
  ): Promise<ApiResult> {
    const r = await this.adminAuthService.login(dto.username, dto.password, ip);
    if (r) return { code: BusinessCode.OK, message: 'success', data: r };
    return { code: BusinessCode.UNAUTHENTICATED, message: 'invalid credentials' };
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/renew-access')
  @ApiOperation({ summary: '管理员 refresh 轮换（家族化 + 重用检测）' })
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
  @ApiOperation({ summary: '管理员登出' })
  async logout(@Body() dto: AdminRefreshDto): Promise<ApiResult> {
    await this.adminAuthService.revokeAdminRefreshToken(dto.refreshToken);
    return { code: BusinessCode.OK, message: 'success' };
  }

  // ===== 用户管理 =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users')
  @ApiOperation({ summary: '用户列表（分页 + 搜索）' })
  async listUsers(@Body() dto: AdminListUsersDto): Promise<ApiResult> {
    const where = dto.search
      ? { uniqName: { contains: dto.search, mode: 'insensitive' as const } }
      : undefined;
    const [list, total] = await Promise.all([
      this.userManageService.getUserList({
        where,
        skip: dto.skip ?? 0,
        take: dto.take ?? 20,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);
    list.forEach((u) => delete (u as any).hashPwd);
    return { code: BusinessCode.OK, message: 'success', data: { list, total } };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/disable')
  @ApiOperation({ summary: '封禁用户（软删除 + 强制下线）' })
  async disableUser(@Param('id') id: string): Promise<ApiResult> {
    await this.prisma.user.update({ where: { id: Number(id) }, data: { isDeleted: true } });
    await this.authService.invalidateAllSessions(Number(id), 'admin_disabled');
    return { code: BusinessCode.OK, message: 'success' };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/enable')
  @ApiOperation({ summary: '解禁用户' })
  async enableUser(@Param('id') id: string): Promise<ApiResult> {
    await this.prisma.user.update({ where: { id: Number(id) }, data: { isDeleted: false } });
    return { code: BusinessCode.OK, message: 'success' };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/force-logout')
  @ApiOperation({ summary: '强制下线（吊销该用户所有会话）' })
  async forceLogout(@Param('id') id: string): Promise<ApiResult> {
    await this.authService.invalidateAllSessions(Number(id), 'admin_force_logout');
    return { code: BusinessCode.OK, message: 'success' };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/sessions')
  @ApiOperation({ summary: '查指定用户活跃会话' })
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
  @ApiOperation({ summary: '重置用户密码（吊销所有会话）' })
  async resetPassword(
    @Param('id') id: string,
    @Body() dto: AdminResetPasswordDto,
  ): Promise<ApiResult> {
    const hash = await this.authService.hashStr(dto.newPassword);
    await this.prisma.user.update({ where: { id: Number(id) }, data: { hashPwd: hash } });
    await this.authService.invalidateAllSessions(Number(id), 'admin_reset_password');
    return { code: BusinessCode.OK, message: 'success' };
  }

  // ===== 封禁管理 =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/bans')
  @ApiOperation({ summary: '列当前登录封禁（IP/账户）' })
  async listBans(): Promise<ApiResult> {
    return { code: BusinessCode.OK, message: 'success', data: this.localStrategy.listBans() };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/bans/unban')
  @ApiOperation({ summary: '解封（IP 和/或账户）' })
  async unban(@Body() dto: AdminUnbanDto): Promise<ApiResult> {
    this.localStrategy.clearBan({ ip: dto.ip, uniqName: dto.uniqName });
    return { code: BusinessCode.OK, message: 'success' };
  }

  // ===== reuse 审计 =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/reuse-alerts')
  @ApiOperation({ summary: 'refresh token 重用告警（revokeReason=reuse）' })
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

  // ===== 全系统活跃会话总览 =====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/sessions')
  @ApiOperation({ summary: '全系统活跃会话总览（跨用户，可筛 userId/ip）' })
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
          user: { select: { id: true, uniqName: true } },
        },
      }),
      this.prisma.refreshToken.count({ where }),
    ]);
    return { code: BusinessCode.OK, message: 'success', data: { list, total } };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/sessions/purge')
  @ApiOperation({ summary: '一键清理所有活跃会话（强制全部用户重登，access 立即失效）' })
  async purgeAllSessions(): Promise<ApiResult> {
    // 找所有有活跃会话的用户，逐个 invalidateAllSessions（bump tokenVersion + 吊销 refresh）
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

  // ===== 实时连接观测（SSE 在线流，内存态，只读）=====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/connections')
  @ApiOperation({ summary: '当前在线 SSE 连接总览（按用户聚合）' })
  async listConnections(): Promise<ApiResult> {
    const snap = this.sseService.snapshot();
    if (snap.clients.length === 0) {
      return { code: BusinessCode.OK, message: 'success', data: snap };
    }
    // 一次性补全用户名，避免 N+1
    const users = await this.prisma.user.findMany({
      where: { id: { in: snap.clients.map((c) => c.userId) } },
      select: { id: true, uniqName: true },
    });
    const nameMap = new Map(users.map((u) => [u.id, u.uniqName]));
    return {
      code: BusinessCode.OK,
      message: 'success',
      data: {
        total: snap.total,
        uniqueUsers: snap.uniqueUsers,
        clients: snap.clients.map((c) => ({
          ...c,
          uniqName: nameMap.get(c.userId) ?? null,
        })),
      },
    };
  }

  // ===== 管理员会话（独立 AdminRefreshToken 表）=====

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/admin-sessions')
  @ApiOperation({ summary: '管理员活跃会话列表（join Admin 出 username）' })
  async listAdminSessions(@Body() dto: AdminListSessionsDto): Promise<ApiResult> {
    const where = {
      revokedAt: null,
      expiresAt: { gt: new Date() },
      ...(dto.ip ? { ip: { contains: dto.ip } } : {}),
    };
    const [list, total] = await Promise.all([
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
          admin: { select: { id: true, username: true } },
        },
      }),
      this.prisma.adminRefreshToken.count({ where }),
    ]);
    return { code: BusinessCode.OK, message: 'success', data: { list, total } };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/admin-sessions/:jti/revoke')
  @ApiOperation({ summary: '吊销指定管理员会话（按 jti；其 access 15m 内仍有效）' })
  async revokeAdminSession(@Param('jti') jti: string): Promise<ApiResult> {
    await this.prisma.adminRefreshToken.updateMany({
      where: { jti, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'admin_revoke' },
    });
    return { code: BusinessCode.OK, message: 'success' };
  }
}
