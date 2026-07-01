import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import { jwtConstants } from './constants.js';
import { RedisService } from '../redis/redis.service.js';
import { PrismaService } from '../prisma.service.js';

type AccessPayload = {
  sub: number;
  jti?: string;
  tver?: number;
  iat?: number;
  exp?: number;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtConstants.accessSecret,
    });
  }

  /**
   * 撤销感知校验（签名/过期已由 Passport 验过）：
   * 1. jti 黑名单（单 token 吊销）→ 拒（Redis 不可用时 fail-open）
   * 2. tokenVersion（全设备登出/改密）claim.tver === 当前 → 否则拒
   * 兼容旧 access（无 jti/tver，Phase 2 前签发）：放行至自然过期(≤15min)。
   * 返回 null → Passport 抛 401。
   */
  async validate(payload: AccessPayload) {
    if (!payload.jti || payload.tver === undefined) {
      return { userId: payload.sub }; // 旧 token 兼容
    }
    if (this.redis.enabled) {
      const blocked = await this.redis
        .existsKey(`access:jti:${payload.jti}`)
        .catch(() => false);
      if (blocked) return null;
    }
    const cur = await this.currentTokenVersion(payload.sub);
    if (cur !== payload.tver) return null;
    return { userId: payload.sub };
  }

  /** 当前 tokenVersion：Redis 缓存(60s) → DB 回退；Redis 异常回查 DB（正确性不丢）。 */
  private async currentTokenVersion(userId: number): Promise<number> {
    if (this.redis.enabled) {
      const cached = await this.redis
        .get(`access:tver:${userId}`)
        .catch(() => null);
      if (cached !== null) return Number(cached);
    }
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true },
    });
    if (!u) return -1; // 用户不存在 → 不匹配任何 tver → 拒
    if (this.redis.enabled) {
      await this.redis
        .setex(`access:tver:${userId}`, 60, String(u.tokenVersion))
        .catch(() => {});
    }
    return u.tokenVersion;
  }
}
