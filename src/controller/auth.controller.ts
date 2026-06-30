import {
  Controller,
  Post,
  Request,
  UseGuards,
  Body,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LocalAuthGuard } from '../auth/local-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard';
import { AuthService } from '../auth/auth.service';
import { LoginAuthInfo } from 'src/auth/local.strategy';
import { ApiResult } from '../common/api-result';
import { BusinessCode } from '../common/business-code';
import {
  LoginDto,
  RefreshTokenDto,
  LogoutDto,
  ChangePasswordDto,
  RevokeSessionDto,
} from '../dto/auth.dto';

@ApiTags('auth')
@Controller()
@UseGuards(ThrottleGuard)
export class AuthController {
  constructor(private authService: AuthService) {}

  @UseGuards(LocalAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('auth/login')
  @ApiOperation({ summary: '登录（凭据换 access/refresh token）' })
  // login 走 LocalStrategy，body 不经 @Body DTO；用 @ApiBody 文档化请求体即可。
  @ApiBody({ type: LoginDto })
  async login(@Request() req): Promise<ApiResult> {
    const authInfo: LoginAuthInfo = req.user;
    if (authInfo.status === 0) {
      return {
        code: BusinessCode.OK,
        message: 'successful',
        data: await this.authService.login(authInfo.userId),
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
  ): Promise<ApiResult<{ access_token: string; refresh_token: string }>> {
    try {
      const { access, refresh } = await this.authService.rotateRefreshToken(
        dto.refreshToken,
      );
      return {
        code: BusinessCode.OK,
        message: 'success',
        data: { access_token: access, refresh_token: refresh },
      };
    } catch (e) {
      // rotateRefreshToken 失败抛 reason 字符串：reuse → 家族已连根吊销，前端须强制重登；
      // invalid/expired → 普通 401。
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
  ): Promise<ApiResult<{ access_token: string; refresh_token: string }>> {
    try {
      const { access, refresh } = await this.authService.rotateRefreshToken(
        dto.refreshToken,
      );
      return {
        code: BusinessCode.OK,
        message: 'success',
        data: { access_token: access, refresh_token: refresh },
      };
    } catch (e) {
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
  async logout(@Body() dto: LogoutDto): Promise<ApiResult> {
    // 前端发 'public' 头 + body，无需 JWT 鉴权，以 refresh token 持有证明吊销。
    await this.authService.logout(dto.refreshToken);
    if (dto.accessJti) {
      await this.authService.blacklistAccessJti(dto.accessJti, 15 * 60);
    }
    return { code: BusinessCode.OK, message: 'success' };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('auth/logout-all')
  @ApiOperation({ summary: '全设备登出（吊销所有会话 + bump tokenVersion）' })
  async logoutAll(@Request() req): Promise<ApiResult> {
    await this.authService.invalidateAllSessions(req.user.userId, 'all_devices');
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
  ): Promise<ApiResult> {
    const r = await this.authService.changePassword(
      req.user.userId,
      dto.oldPassword,
      dto.newPassword,
    );
    if (r.ok) {
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
}
