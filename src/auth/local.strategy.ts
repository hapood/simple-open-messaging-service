import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import { AuthService } from './auth.service';
import { User as UserModel } from '@prisma/client';
import { Request } from 'express'

export interface LoginAuthInfo {
  status: number,
  uniqName: string,
  userId?: number,
  bannedUntil?: number
}
@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  private readonly _ipBlackDict: Record<string, { ip: string, cnt: number, bannedUntil: number }> = {}
  private _blackLogList: { ip: string, date: number }[] = []
  private _timer: NodeJS.Timeout | undefined


  constructor(private authService: AuthService) {
    super({
      usernameField: 'username',
      passwordField: 'password',
      passReqToCallback: true
    });
    this._timer = setInterval(() => {
      const now = new Date().getTime(), list = this._blackLogList, dict = this._ipBlackDict
      let i = 0
      for (; i < list.length; i++) {
        let item = list[i], bannedUntil = dict[item.ip].bannedUntil
        if (now - item.date > 2 * 24 * 60 * 60 * 1000) {
          if (now > bannedUntil) {
            delete dict[item.ip]
          }
          continue
        } else {
          break
        }
      }
      this._blackLogList = list.slice(i)
    })
  }

  async validate(req: Request, uniqName: string, password: string): Promise<LoginAuthInfo> {
    const ip = req.ip
    const _ipBlackInfo = this._ipBlackDict[ip]
    if (_ipBlackInfo !== undefined) {
      if (new Date().getTime() < _ipBlackInfo.bannedUntil) {
        return {
          status: 1,
          uniqName,
          bannedUntil: _ipBlackInfo.bannedUntil
        }
      }
    }
    const user = await this.authService.validateUser(uniqName, password);
    if (user === undefined) {
      let info = this._ipBlackDict[ip]
      if (info === undefined) {
        this._ipBlackDict[ip] = { ip, cnt: 1, bannedUntil: new Date().getTime() }
      } else {
        info.cnt += 1
        this._blackLogList.push({
          ip, date: new Date().getTime()
        })
        if (info.cnt > 9) {
          info.bannedUntil = new Date().getTime() + 24 * 60 * 60 * 1000
        } else if (info.cnt > 6) {
          info.bannedUntil = new Date().getTime() + 3 * 60 * 60 * 1000
        } else if (info.cnt > 3) {
          info.bannedUntil = new Date().getTime() + 30 * 60 * 1000
        }
      }
      return {
        status: 1,
        uniqName,
      }
    }
    return {
      status: 0,
      uniqName,
      userId: user.id
    };
  }
}