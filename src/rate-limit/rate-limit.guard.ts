import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { AuthPolicyRegistry } from './auth-policy.registry.js';
import { RATE_LIMIT_POLICY_METADATA } from './rate-limit.decorator.js';
import { RateLimitService } from './rate-limit.service.js';

/** Opt-in policy guard with per-policy shadow/enforce/disabled rollout. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policies: AuthPolicyRegistry,
    private readonly rateLimits: RateLimitService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const name = this.reflector.getAllAndOverride<string>(
      RATE_LIMIT_POLICY_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!name) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const result = this.rateLimits.evaluate(this.policies.build(name, request));
    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1_000));
      const reply = context.switchToHttp().getResponse<FastifyReply>();
      reply.header('Retry-After', String(retryAfter));
      throw new BusinessException(
        BusinessCode.RATE_LIMITED,
        'too many requests',
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAfter },
      );
    }
    return true;
  }
}
