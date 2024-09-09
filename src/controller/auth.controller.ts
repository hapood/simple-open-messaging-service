import {
  Controller,
  Post,
  Request,
  UseGuards,
  Body
} from '@nestjs/common';
import { User as UserModel } from '@prisma/client';
import { LocalAuthGuard } from '../auth/local-auth.guard';
import { AuthService } from '../auth/auth.service';
import { LoginAuthInfo } from 'src/auth/local.strategy';
@Controller()
export class AuthController {
  constructor(
    private authService: AuthService
  ) { }

  @UseGuards(LocalAuthGuard)
  @Post('auth/login')
  async login(@Request() req) {
    const authInfo: LoginAuthInfo = req.user;
    if (authInfo.status === 0) {
      return {
        status: 0, message: 'successful',
        data: await this.authService.login(authInfo.userId)
      }
    } else {
      if (authInfo.bannedUntil !== undefined) {
        return {
          code: 2,
          message: 'too many bad attemp',
          data: {
            bannedUntil: authInfo.bannedUntil
          }
        }
      } else {
        return {
          code: 1,
          message: 'error username/password'
        }
      }
    }
  }

  @Post('auth/renew-access')
  async renewaccessTokens(@Body() { refreshToken }: { refreshToken: string }) {
    const info = this.authService.checkRefreshTokenInfo(refreshToken)
    console.log(info,1223)
    if (info !== undefined) {
      this.authService.removeRefreshToken(info.sub, refreshToken)
      return {
        status: 0,
        message: 'success',
        data: {
          access_token: this.authService.getAccessToken(info.sub)
        }
      }
    } else {
      return {
        status: 1,
        message: 'refresh_token is invalid',
      }
    }
  }

  @Post('auth/renew-refresh')
  async renewRefreshTokens(@Body() { refreshToken }: { refreshToken: string }) {
    const info = this.authService.checkRefreshTokenInfo(refreshToken)
    this.authService.removeRefreshToken(info.sub, refreshToken)
    if (info !== undefined) {
      return {
        code: 0,
        message: 'success',
        data: {
          access_token: this.authService.getAccessToken(info.sub),
          refresh_token: this.authService.getRefreshToken(info.sub)
        }
      }
    } else {
      return {
        code: 1,
        message: 'refresh_token is invalid',
      }
    }
  }

  @Post('auth/logout')
  async logout(@Request() req) {
    const userId = req.user['sub'], refreshToken = req.user['refreshToken'];
    this.authService.removeRefreshToken(userId, refreshToken)
    return true
  }
}