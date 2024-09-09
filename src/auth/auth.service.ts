import { Injectable, OnModuleInit, OnModuleDestroy, forwardRef, Inject } from '@nestjs/common';
import { UserService } from '../user/user.service';
import { JwtService } from '@nestjs/jwt';
import { User as UserModel } from '@prisma/client';
import * as argon2 from 'argon2';
import { JwtPayload } from './model';

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly _refreshTokenDict: Record<string, number> = {}
  private _tokenRecordList: { userId: number, date: number, token: string }[] = []
  private _timer: NodeJS.Timeout | undefined
  constructor(
    @Inject(forwardRef(() => UserService)) private userService: UserService, private jwtService: JwtService) {
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

  async onModuleInit() {
  }

  async onModuleDestroy() {
    clearInterval(this._timer)
  }

  async validateUser(uniqName: string, password: string): Promise<UserModel | undefined> {
    const user = await this.userService.findUniqueUser({ uniqName });
    if (user === null) {
      return undefined
    }
    const match = await argon2.verify(user.hashPwd, password);
    if (match === true) {
      return user;
    }
    return undefined;
  }

  async hashStr(str: string) {
    return argon2.hash(str)
  }

  async login(userId: number) {
    return {
      access_token: this.getAccessToken(userId),
      refresh_token: this.getRefreshToken(userId)
    };
  }

  async logout(userId: number, refreshToken: string) {
  }

  async bindRefreshTokenToUser(userId: number, refreshToken: string) {
    this._refreshTokenDict[refreshToken] = userId
    this._tokenRecordList.push({ userId, date: new Date().getTime(), token: refreshToken })
    return true
  }

  checkRefreshTokenInfo(refreshToken: string) {
    const payload: JwtPayload | null = this.jwtService.decode(refreshToken)
    if (payload !== null && this._refreshTokenDict[refreshToken] === payload.sub &&
      new Date().getTime() < payload.exp * 1000) {
      return payload
    }
    else {
      return undefined
    }
  }

  removeRefreshToken(userId: number, refreshToken: string) {
    let list = this._refreshTokenDict[userId]
    if (list) {
      delete this._refreshTokenDict[refreshToken]
    }
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