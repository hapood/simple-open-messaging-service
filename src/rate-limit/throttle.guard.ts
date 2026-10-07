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
import { ClientIdentityService } from './client-identity.service.js';
import {
  FixedWindowPolicyService,
  type FixedWindowPolicyName,
} from './fixed-window-policy.service.js';

export const THROTTLE_KEY = 'throttle';

/** Bind a route (or controller) to a database-backed fixed-window policy. */
export const Throttle = (policy: FixedWindowPolicyName) =>
  SetMetadata(THROTTLE_KEY, policy);

/**
 * Simple fixed-window rate limiter (in-process KV store counter): key = rl:<policy>:<IP>.
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
    private readonly policies: FixedWindowPolicyService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<FixedWindowPolicyName>(
      THROTTLE_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!policy) return true; // endpoints not annotated with @Throttle are not rate-limited
    const cfg = this.policies.get(policy);
    // Resolve through the same explicit CIDR trust boundary used by Fastify and the policy engine.
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const ip = this.clientIdentity.fromRequest(req)?.address ?? 'unknown';
    const n = await this.kvStore.incrWithExpire(
      this.policies.bucketKey(policy, ip),
      cfg.windowSeconds,
    );
    if (n > cfg.limit) {
      throw new HttpException(
        'too many requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
