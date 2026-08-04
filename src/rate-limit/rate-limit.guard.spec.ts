import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { HttpStatus, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RateLimitGuard } from './rate-limit.guard.js';
import { RATE_LIMIT_POLICY_METADATA } from './rate-limit.decorator.js';
import type { AuthPolicyRegistry } from './auth-policy.registry.js';
import type { RateLimitService } from './rate-limit.service.js';
import type { RateLimitPolicy } from './rate-limit.types.js';

describe('RateLimitGuard', () => {
  it('evaluates a shadow policy and always allows the effective request', () => {
    const handler = () => undefined;
    Reflect.defineMetadata(
      RATE_LIMIT_POLICY_METADATA,
      'auth.password.login',
      handler,
    );
    const policy: RateLimitPolicy = {
      name: 'auth.password.login',
      mode: 'shadow',
      rules: [
        {
          subject: { type: 'ip-exact', key: 'ip4:192.0.2.1' },
          ratePerSecond: 1,
          burst: 1,
        },
      ],
    };
    const registry = { build: vi.fn().mockReturnValue(policy) };
    const rateLimits = {
      evaluate: vi.fn().mockReturnValue({
        policy: policy.name,
        mode: 'shadow',
        allowed: true,
        wouldBlock: true,
        retryAfterMs: 1_000,
        rules: [],
      }),
    };
    const request = {} as FastifyRequest;
    const context = {
      getHandler: () => handler,
      getClass: () => class TestController {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    const guard = new RateLimitGuard(
      new Reflector(),
      registry as unknown as AuthPolicyRegistry,
      rateLimits as unknown as RateLimitService,
    );

    expect(guard.canActivate(context)).toBe(true);
    expect(registry.build).toHaveBeenCalledWith('auth.password.login', request);
    expect(rateLimits.evaluate).toHaveBeenCalledWith(policy);
  });

  it('sets Retry-After and throws the uniform business exception in enforce mode', () => {
    const handler = () => undefined;
    Reflect.defineMetadata(
      RATE_LIMIT_POLICY_METADATA,
      'auth.password.login',
      handler,
    );
    const registry = {
      build: vi.fn().mockReturnValue({
        name: 'auth.password.login',
        mode: 'enforce',
        rules: [],
      }),
    };
    const rateLimits = {
      evaluate: vi.fn().mockReturnValue({
        policy: 'auth.password.login',
        mode: 'enforce',
        allowed: false,
        wouldBlock: true,
        retryAfterMs: 1_001,
        rules: [],
      }),
    };
    const reply = { header: vi.fn() };
    const request = {} as FastifyRequest;
    const context = {
      getHandler: () => handler,
      getClass: () => class TestController {},
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => reply,
      }),
    } as unknown as ExecutionContext;
    const guard = new RateLimitGuard(
      new Reflector(),
      registry as unknown as AuthPolicyRegistry,
      rateLimits as unknown as RateLimitService,
    );

    expect(() => guard.canActivate(context)).toThrowError(
      expect.objectContaining({
        bizCode: 10005,
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 10005,
          message: 'too many requests',
          data: { retryAfter: 2 },
        },
      }),
    );
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '2');
  });
});
