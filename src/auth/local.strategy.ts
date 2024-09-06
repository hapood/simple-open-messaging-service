import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import { AuthService } from './auth.service';
import { User as UserModel } from '@prisma/client';
import { Request } from 'express'

export interface AuthInfo {
  status: number,
  uniqName: string,
  userId?: number,
  bannedUntil: number
}
@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  private readonly _ipBlackDict: Record<string, { ip: string, cnt: number, bannedUntil?: number }> = {}
  private _ipRecordList: { userId: number, date: number, token: string }[] = []
  private _timer: NodeJS.Timeout | undefined


  constructor(private authService: AuthService) {
    super({
      usernameField: 'username',
      passwordField: 'password',
      passReqToCallback: true
    });
    this._timer = setInterval(() => {
    })
  }

  async validate(req: Request, uniqName: string, password: string): Promise<AuthInfo> {
    const ip = req.ip
    const ipBlackInfo = this._ipBlackDict[ip]
    if (ipBlackInfo !== undefined) {
      if (new Date().getTime() < ipBlackInfo.bannedUntil) {
        return {
          status: 1,
          uniqName,
          bannedUntil: ipBlackInfo.bannedUntil
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
        if (info.cnt > 3) {

        }
      }
    }
    return user;
  }
}