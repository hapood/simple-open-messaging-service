import {
  Controller,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { User as UserModel } from '@prisma/client';
import { LocalAuthGuard } from '../auth/local-auth.guard';
import { AuthService } from '../auth/auth.service';
import { JwtRefreshGuard } from 'src/auth/jwt-refresh.guard';

@Controller()
export class AuthController {
  constructor(
    private authService: AuthService
  ) { }

  @UseGuards(LocalAuthGuard)
  @Post('auth/login')
  async login(@Request() req) {
    return await this.authService.login(req.user as UserModel)
  }

  @UseGuards(JwtRefreshGuard)
  @Post('auth/renew')
  async refreshTokens(@Request() req) {
    const user = req.user;
    if (user) {
      const userId = req.user['sub'], refreshToken = req.user['refreshToken'];
      const isValid = this.authService.checkRefreshTokenValid(userId, refreshToken)
      this.authService.removeRefreshToken(userId, refreshToken)
      if (isValid) {
        const [access_token, refresh_token] = await this.authService.getTokens(userId);
        return {
          code: 0,
          data: { access_token, refresh_token }
        }
      }
    } else {
      return {
        code: 1,
        message: 'error username/password'
      }
    }
  }

  @UseGuards(JwtRefreshGuard)
  @Post('auth/logout')
  async logout(@Request() req) {
    const userId = req.user['sub'], refreshToken = req.user['refreshToken'];
    this.authService.removeRefreshToken(userId, refreshToken)
    return true
  }

}