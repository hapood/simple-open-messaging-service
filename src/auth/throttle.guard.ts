import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../redis/redis.service';

export const THROTTLE_KEY = 'throttle';

/** 端点限流配置：limit 次 / ttlSec 秒。未标注的端点 guard 直接放行。 */
export const Throttle = (limit = 30, ttlSec = 60) =>
  SetMetadata(THROTTLE_KEY, { limit, ttlSec });

/**
 * 简单固定窗口限流（进程内 KV store 计数）：键 = rl:<路径>:<IP>。
 * 超限抛 429 → AllExceptionsFilter 映射为 RATE_LIMITED(10005)。
 * 用于鉴权敏感端点（renew-access、renew-refresh、logout、change-password）防刷。
 */
@Injectable()
export class ThrottleGuard implements CanActivate {
  constructor(
    private readonly redis: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const cfg = this.reflector.get<{ limit: number; ttlSec: number }>(
      THROTTLE_KEY,
      ctx.getHandler(),
    );
    if (!cfg) return true; // 未标 @Throttle 的端点不限流
    const req = ctx.switchToHttp().getRequest();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const n = await this.redis.incrWithExpire(`rl:${req.path}:${ip}`, cfg.ttlSec);
    if (n > cfg.limit) {
      throw new HttpException('too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
