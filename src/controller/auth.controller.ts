import {
  Controller,
  Post,
  Request,
  UseGuards,
  Body,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LocalAuthGuard } from '../auth/local-auth.guard';
import { AuthService } from '../auth/auth.service';
import { LoginAuthInfo } from 'src/auth/local.strategy';
import { ApiResult } from '../common/api-result';
import { BusinessCode } from '../common/business-code';
import { LoginDto, RefreshTokenDto } from '../dto/auth.dto';

@ApiTags('auth')
@Controller()
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

  @HttpCode(HttpStatus.OK)
  @Post('auth/logout')
  @ApiOperation({ summary: '登出（吊销 refresh token）' })
  async logout(@Body() dto: RefreshTokenDto): Promise<ApiResult> {
    // refreshToken 从 body 取（原实现从 JWT payload 取，恒为 undefined）。
    // 前端发 'public' 头 + body，故此端点无需 JWT 鉴权，以 refresh token 作为持有证明吊销。
    await this.authService.logout(dto.refreshToken);
    return {
      code: BusinessCode.OK,
      message: 'success',
    };
  }
}
