import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import { jwtConstants } from '../auth/constants';

/**
 * Admin JWT 策略（独立 'admin-jwt'）：用独立 adminSecret 校验，且必须带 scope:'admin'。
 * 与用户 JwtStrategy 物理隔离——用户 token 进不来 admin 端点，admin token 也不通用户端点。
 */
@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtConstants.adminSecret,
    });
  }

  async validate(payload: { sub: number; scope?: string }) {
    if (payload.scope !== 'admin') return null; // 非 admin token 拒绝
    return { adminId: payload.sub };
  }
}
