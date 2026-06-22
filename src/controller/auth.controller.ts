import { Controller, Post, Request, UseGuards, Body } from '@nestjs/common';
import { LocalAuthGuard } from '../auth/local-auth.guard';
import { AuthService } from '../auth/auth.service';
import { LoginAuthInfo } from 'src/auth/local.strategy';
@Controller()
export class AuthController {
  constructor(private authService: AuthService) {}

  @UseGuards(LocalAuthGuard)
  @Post('auth/login')
  async login(@Request() req) {
    const authInfo: LoginAuthInfo = req.user;
    if (authInfo.status === 0) {
      return {
        status: 0,
        message: 'successful',
        data: await this.authService.login(authInfo.userId),
      };
    } else {
      if (authInfo.bannedUntil !== undefined) {
        return {
          status: 2,
          message: 'too many bad attemp',
          data: {
            bannedUntil: authInfo.bannedUntil,
          },
        };
      } else {
        return {
          status: 1,
          message: 'error username/password',
        };
      }
    }
  }

  @Post('auth/renew-access')
  async renewaccessTokens(@Body() { refreshToken }: { refreshToken: string }) {
    const userId = await this.authService.verifyRefreshToken(refreshToken);
    if (userId !== undefined) {
      // 仅刷新 access，不动 refresh（原实现会 removeRefreshToken，误删后 7 天定时续期会失效）
      return {
        status: 0,
        message: 'success',
        data: {
          access_token: this.authService.getAccessToken(userId),
        },
      };
    } else {
      return {
        status: 1,
        message: 'refresh_token is invalid',
      };
    }
  }

  @Post('auth/renew-refresh')
  async renewRefreshTokens(@Body() { refreshToken }: { refreshToken: string }) {
    const userId = await this.authService.verifyRefreshToken(refreshToken);
    // 先校验有效性再吊销（原实现 info 可能为 undefined 即 removeRefreshToken → 抛 500）
    if (userId !== undefined) {
      await this.authService.revokeRefreshToken(refreshToken);
      return {
        status: 0,
        message: 'success',
        data: {
          access_token: this.authService.getAccessToken(userId),
          refresh_token: await this.authService.getRefreshToken(userId),
        },
      };
    } else {
      return {
        status: 1,
        message: 'refresh_token is invalid',
      };
    }
  }

  @Post('auth/logout')
  async logout(@Body() { refreshToken }: { refreshToken: string }) {
    // refreshToken 从 body 取（原实现从 JWT payload 取，恒为 undefined）。
    // 前端发 'public' 头 + body，故此端点无需 JWT 鉴权，以 refresh token 作为持有证明吊销。
    await this.authService.logout(refreshToken);
    return {
      status: 0,
      message: 'success',
    };
  }
}
