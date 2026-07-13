import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { RedisService } from '../redis/redis.service.js';

export const THROTTLE_KEY = 'throttle';

/** Endpoint rate-limit config: limit requests per ttlSec seconds. Unannotated endpoints are passed through by the guard. */
export const Throttle = (limit = 30, ttlSec = 60) =>
  SetMetadata(THROTTLE_KEY, { limit, ttlSec });

/**
 * Simple fixed-window rate limiter (in-process KV store counter): key = rl:<path>:<IP>.
 * Throws 429 when exceeded → AllExceptionsFilter maps it to RATE_LIMITED(10005).
 * Used to protect auth-sensitive endpoints (renew-access, renew-refresh, logout, change-password) against abuse.
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
    if (!cfg) return true; // endpoints not annotated with @Throttle are not rate-limited
    // FastifyRequest exposes `.ip` (resolves the real client IP via the adapter's trustProxy),
    // but has no `.socket`/`.path` — fall back to the raw Node socket and derive the path from
    // `.url` (Express's `.path` does not exist here).
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const ip = req.ip ?? req.raw?.socket?.remoteAddress ?? 'unknown';
    const path = req.url?.split('?')[0] ?? 'unknown';
    const n = await this.redis.incrWithExpire(`rl:${path}:${ip}`, cfg.ttlSec);
    if (n > cfg.limit) {
      throw new HttpException(
        'too many requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
