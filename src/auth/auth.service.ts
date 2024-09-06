import { Injectable, ConflictException } from '@nestjs/common';
import { UserService } from '../user/user.service';
import { JwtService } from '@nestjs/jwt';
import { User as UserModel } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

const refreshTokenDict: Record<number, string[]> = {}
@Injectable()
export class AuthService {
  constructor(private userService: UserService, private prisma: PrismaService,
    private jwtService: JwtService) { }

  async validateUser(uniqName: string, password: string): Promise<any> {
    const user = await this.userService.findOne({ uniqName });
    const match = await argon2.verify(user.password, password);
    if (match === true) {
      return user;
    }
    return null;
  }

  async hashStr(str: string) {
    return argon2.hash(str)
  }

  async login(user: UserModel) {
    const [access_token, refreshToken] = await this.getTokens(user.id);
    await this.bindRefreshTokenToUser(user.id, refreshToken);
    return {
      access_token, refreshToken
    };
  }

  async logout(userId: number, refreshToken: string) {
  }

  async bindRefreshTokenToUser(userId: number, refreshToken: string) {
    let list = refreshTokenDict[userId];
    if (list === undefined) {
      list = refreshTokenDict[userId] = []
    }
    list.push(refreshToken)
    return true
  }

  checkRefreshTokenValid(userId: number, refreshToken: string) {
    let token = refreshTokenDict[userId]?.find(token => token === refreshToken)
    return token !== undefined
  }

  removeRefreshToken(userId: number, refreshToken: string) {
    let list = refreshTokenDict[userId]
    if (list) {
      const newList = refreshTokenDict[userId].filter(token => token !== refreshToken)
      if (list.length > 0) {
        refreshTokenDict[userId] = newList
      } else {
        delete refreshTokenDict[userId]
      }
    }
  }

  async register(data: Prisma.UserCreateInput) {
    return await this.prisma.$transaction(async (prisma) => {
      const user = await prisma.user.findFirst({
        where: { uniqName: data.uniqName },
      });
      if (user !== undefined) {
        new ConflictException(`User ${data.uniqName} already exists`);
      }
      data.password = await this.hashStr(data.password)
      const newUser = await prisma.user.create({
        data,
      });
      const [access_token, refresh_token] = await this.getTokens(newUser.id)
      return {
        id: newUser.id,
        uniqName: newUser.uniqName,
        access_token,
        refresh_token
      }
    })
  }

  async getTokens(userId: number) {
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        {
          sub: userId,
        },
        {
          expiresIn: '15m',
        },
      ),
      this.jwtService.signAsync(
        {
          sub: userId,
        },
        {
          expiresIn: '14d',
        },
      ),
    ]);
    this.bindRefreshTokenToUser(userId, refreshToken)
    return [
      accessToken,
      refreshToken,
    ]
  }
}