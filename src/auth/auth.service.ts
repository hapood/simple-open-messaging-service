import { Injectable, ConflictException } from '@nestjs/common';
import { UserService } from '../user/user.service';
import { JwtService } from '@nestjs/jwt';
import { User as UserModel } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class AuthService {
  private readonly _refreshTokenDict: Record<string, number> = {}
  private _tokenRecordList: { userId: number, date: number, token: string }[] = []
  private _timer: NodeJS.Timeout | undefined
  constructor(private userService: UserService, private prisma: PrismaService,
    private jwtService: JwtService) {
    this._timer = setInterval(() => {
      const now = new Date().getTime(), tokenRecordList = this._tokenRecordList, refreshTokenDict = this._tokenRecordList
      let i = 0
      for (; i < tokenRecordList.length; i++) {
        let item = tokenRecordList[i]
        if (now - item.date > 15 * 24 * 60 * 60 * 1000) {
          //too old
          delete refreshTokenDict[item.token]
          continue
        } else {
          break
        }
      }
      this._tokenRecordList = tokenRecordList.slice(i)
    }, 1000 * 60 * 60 * 24)
  }

  async onModuleDestroy() {
    clearInterval(this._timer)
  }

  async validateUser(uniqName: string, password: string): Promise<UserModel | undefined> {
    const user = await this.userService.findOne({ uniqName });
    const match = await argon2.verify(user.hashPwd, password);
    if (match === true) {
      return user;
    }
    return undefined;
  }

  async hashStr(str: string) {
    return argon2.hash(str)
  }

  async login(user: UserModel) {
    return {
      access_token: this.getAccessToken(user.id),
      refresh_token: this.getRefreshToken(user.id)
    };
  }

  async logout(userId: number, refreshToken: string) {
  }

  async bindRefreshTokenToUser(userId: number, refreshToken: string) {
    this._refreshTokenDict[refreshToken] = userId
    this._tokenRecordList.push({ userId, date: new Date().getTime(), token: refreshToken })
    return true
  }

  checkRefreshTokenValid(userId: number, refreshToken: string) {
    return this._refreshTokenDict[refreshToken] === userId
  }

  removeRefreshToken(userId: number, refreshToken: string) {
    let list = this._refreshTokenDict[userId]
    if (list) {
      delete this._refreshTokenDict[refreshToken]
    }
  }

  async register(data: Prisma.UserCreateInput) {
    return await this.prisma.$transaction(async (prisma) => {
      const user = await prisma.user.findUnique({
        where: { uniqName: data.uniqName },
      });
      if (user !== undefined) {
        new ConflictException(`User ${data.uniqName} already exists`);
      }
      data.hashPwd = await this.hashStr(data.password)
      const newUser = await prisma.user.create({
        data,
      });
      return {
        id: newUser.id,
        uniqName: newUser.uniqName,
      }
    })
  }

  getAccessToken(userId: number) {
    return this.jwtService.sign(
      {
        sub: userId,
      },
      {
        expiresIn: '15m',
      },
    )
  }

  getRefreshToken(userId: number) {
    const refreshToken =
      this.jwtService.sign(
        {
          sub: userId,
        },
        {
          expiresIn: '14d',
        },
      )
    this.bindRefreshTokenToUser(userId, refreshToken)
    return refreshToken

  }
}