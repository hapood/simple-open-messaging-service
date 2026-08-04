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
import { KvStoreService } from '../kv-store/kv-store.service.js';
import { ClientIdentityService } from '../rate-limit/client-identity.service.js';

export const THROTTLE_KEY = 'throttle';

/** Endpoint rate-limit config: limit requests per ttlSec seconds. Unannotated endpoints are passed through by the guard. */
export const Throttle = (limit = 30, ttlSec = 60) =>
  SetMetadata(THROTTLE_KEY, { limit, ttlSec });

/**
 * Simple fixed-window rate limiter (in-process KV store counter): key = rl:<path>:<IP>.
 * Throws 429 when exceeded → AllExceptionsFilter maps it to RATE_LIMITED(10005).
 * Opt-in per route via @Throttle: rate-limits abuse-sensitive endpoints (login, logout, change-password,
 * message-sending, group ops, device registration) against brute-force / flooding.
 */
@Injectable()
export class ThrottleGuard implements CanActivate {
  constructor(
    private readonly kvStore: KvStoreService,
    private readonly reflector: Reflector,
    private readonly clientIdentity: ClientIdentityService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const cfg = this.reflector.get<{ limit: number; ttlSec: number }>(
      THROTTLE_KEY,
      ctx.getHandler(),
    );
    if (!cfg) return true; // endpoints not annotated with @Throttle are not rate-limited
    // Resolve through the same explicit CIDR trust boundary used by Fastify and the policy engine.
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const ip = this.clientIdentity.fromRequest(req)?.address ?? 'unknown';
    const path = req.url?.split('?')[0] ?? 'unknown';
    const n = await this.kvStore.incrWithExpire(`rl:${path}:${ip}`, cfg.ttlSec);
    if (n > cfg.limit) {
      throw new HttpException(
        'too many requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
