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
          message: 'too many bad attemp',
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
  @ApiOperation({ summary: '用 refresh token 换新的 access token（不轮换 refresh）' })
  async renewaccessTokens(
    @Body() dto: RefreshTokenDto,
  ): Promise<ApiResult<{ access_token: string }>> {
    const userId = await this.authService.verifyRefreshToken(dto.refreshToken);
    if (userId !== undefined) {
      // 仅刷新 access，不动 refresh（原实现会 removeRefreshToken，误删后 7 天定时续期会失效）
      return {
        code: BusinessCode.OK,
        message: 'success',
        data: {
          access_token: this.authService.getAccessToken(userId),
        },
      };
    } else {
      return {
        code: BusinessCode.UNAUTHENTICATED,
        message: 'refresh_token is invalid',
      };
    }
  }

  @HttpCode(HttpStatus.OK)
  @Post('auth/renew-refresh')
  @ApiOperation({ summary: '用 refresh token 轮换出新的 access + refresh' })
  async renewRefreshTokens(
    @Body() dto: RefreshTokenDto,
  ): Promise<ApiResult<{ access_token: string; refresh_token: string }>> {
    const userId = await this.authService.verifyRefreshToken(dto.refreshToken);
    // 先校验有效性再吊销（原实现 info 可能为 undefined 即 removeRefreshToken → 抛 500）
    if (userId !== undefined) {
      await this.authService.revokeRefreshToken(dto.refreshToken);
      return {
        code: BusinessCode.OK,
        message: 'success',
        data: {
          access_token: this.authService.getAccessToken(userId),
          refresh_token: await this.authService.getRefreshToken(userId),
        },
      };
    } else {
      return {
        code: BusinessCode.UNAUTHENTICATED,
        message: 'refresh_token is invalid',
      };
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
