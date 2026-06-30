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
} from './admin.dto';
import { ApiResult } from '../common/api-result';
import { BusinessCode } from '../common/business-code';
import { AuthService } from '../auth/auth.service';
import { UserManageService } from '../user-manage/user-manage.service';
import { LocalStrategy } from '../auth/local.strategy';
import { PrismaService } from '../prisma.service';

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
}
