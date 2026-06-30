import {
  Controller,
  Post,
  Body,
  Headers,
  Ip,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthService } from './admin-auth.service';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminLoginDto, AdminRefreshDto } from './admin.dto';
import { ApiResult } from '../common/api-result';
import { BusinessCode } from '../common/business-code';

/**
 * Admin 控制台鉴权端点（Phase A）：login / renew-access / logout。
 * 管理端点（用户/force-logout/sessions/bans/reuse 等）在 Phase B 加，统一挂 AdminAuthGuard + admin/ 前缀。
 */
@ApiTags('admin')
@Controller()
export class AdminController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

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
}
