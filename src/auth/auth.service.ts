import { Injectable } from '@nestjs/common';
import { UserService } from '../user/user.service';
import { JwtService } from '@nestjs/jwt';
import { User as UserModel } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(private userService: UserService,
    private jwtService: JwtService) { }

  async validateUser(uniqName: string, password: string): Promise<any> {
    const user = await this.userService.findOne({ uniqName, password });
    if (user) {
      return user;
    }
    return null;
  }

  async login(user: UserModel) {
    const payload = { uniqName: user.uniqName, userId: user.id };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }
}