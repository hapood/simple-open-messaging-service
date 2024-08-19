import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { User as UserModel } from '@prisma/client';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: AuthService) {
    super();
  }

  async validate(uniqName: string, password: string): Promise<UserModel> {
    const user = await this.authService.validateUser(uniqName, password);
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  }
}