import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { ClientIdentityService } from './client-identity.service.js';
import {
  AUTH_RATE_LIMIT_POLICIES,
  AuthPolicyRegistry,
} from './auth-policy.registry.js';
import { RateLimitService } from './rate-limit.service.js';
import type {
  AuthRateLimitConfig,
  RateLimitModeService,
} from './rate-limit-mode.service.js';

function request(
  body: Record<string, unknown>,
  userId?: number,
  forwardedFor = '2001:db8:1:2::abcd',
): FastifyRequest {
  return {
    body,
    user: userId === undefined ? undefined : { userId },
    raw: { socket: { remoteAddress: '127.0.0.1' } },
    headers: { 'x-forwarded-for': forwardedFor },
  } as unknown as FastifyRequest;
}

describe('AuthPolicyRegistry', () => {
  const originalTrustedProxies = process.env.TRUSTED_PROXY_CIDRS;

  beforeEach(() => {
    process.env.TRUSTED_PROXY_CIDRS = '127.0.0.0/8,::1/128';
  });

  afterEach(() => {
    // No timer teardown: @Interval only schedules inside a Nest context; these tests instantiate
    // RateLimitService directly, so no periodic timer is ever started.
    if (originalTrustedProxies === undefined)
      delete process.env.TRUSTED_PROXY_CIDRS;
    else process.env.TRUSTED_PROXY_CIDRS = originalTrustedProxies;
  });

  function registry(): AuthPolicyRegistry {
    const rateLimits = new RateLimitService();
    return new AuthPolicyRegistry(new ClientIdentityService(), rateLimits, {
      forPolicy: (name: string) => configFor(name, 'shadow'),
    } as RateLimitModeService);
  }

  function enforcingRegistry(rateLimits: RateLimitService): AuthPolicyRegistry {
    return new AuthPolicyRegistry(new ClientIdentityService(), rateLimits, {
      forPolicy: (name: string) => configFor(name, 'enforce'),
    } as RateLimitModeService);
  }

  function configFor(
    name: string,
    mode: AuthRateLimitConfig['mode'],
  ): AuthRateLimitConfig {
    const enforced = (ratePerSecond: number, burst: number) => ({
      ratePerSecond,
      burst,
      enforce: true,
    });
    if (name === AUTH_RATE_LIMIT_POLICIES.passwordLogin) {
      return {
        mode,
        exactIp: enforced(1, 10),
        ipv6Prefix: enforced(5, 30),
        account: { ...enforced(0.2, 5), enforce: false },
      };
    }
    if (name === AUTH_RATE_LIMIT_POLICIES.otpLogin) {
      return {
        mode,
        exactIp: enforced(0.2, 3),
        ipv6Prefix: enforced(1, 10),
        account: { ...enforced(0.1, 3), enforce: false },
      };
    }
    if (name === AUTH_RATE_LIMIT_POLICIES.qrCreate) {
      return {
        mode,
        exactIp: enforced(0.2, 5),
        ipv6Prefix: enforced(1, 15),
      };
    }
    if (name === AUTH_RATE_LIMIT_POLICIES.qrPoll) {
      return {
        mode,
        exactIp: enforced(5, 15),
        qrToken: enforced(1, 3),
      };
    }
    return {
      mode,
      user: enforced(0.5, 5),
      qrToken: enforced(1, 2),
    };
  }

  it('builds password IP, IPv6-prefix and private account rules in shadow mode', () => {
    const policy = registry().build(
      AUTH_RATE_LIMIT_POLICIES.passwordLogin,
      request({ account: 'Alice' }),
    );
    expect(policy.mode).toBe('shadow');
    expect(policy.rules.map((rule) => rule.subject.type)).toEqual([
      'ip-exact',
      'ip-prefix64',
      'account',
    ]);
    expect(JSON.stringify(policy)).not.toContain('Alice');
    expect(JSON.stringify(policy)).not.toContain('alice');
  });

  it('builds all six stable authentication policy names', () => {
    const registryUnderTest = registry();
    const cases = [
      [AUTH_RATE_LIMIT_POLICIES.passwordLogin, { account: 'alice' }, undefined],
      [AUTH_RATE_LIMIT_POLICIES.otpLogin, { account: 'alice' }, undefined],
      [AUTH_RATE_LIMIT_POLICIES.qrCreate, {}, undefined],
      [AUTH_RATE_LIMIT_POLICIES.qrPoll, { qrToken: 'secret-poll' }, undefined],
      [AUTH_RATE_LIMIT_POLICIES.qrScan, { qrToken: 'secret-scan' }, 42],
      [AUTH_RATE_LIMIT_POLICIES.qrConfirm, { qrToken: 'secret-confirm' }, 42],
    ] as const;

    for (const [name, body, userId] of cases) {
      const policy = registryUnderTest.build(name, request(body, userId));
      expect(policy.name).toBe(name);
      expect(policy.rules.length).toBeGreaterThan(0);
      expect(JSON.stringify(policy)).not.toContain('secret-');
    }
  });

  it('uses one /64 rule for rotating IPv6 interface identifiers', () => {
    const policy = registry().build(
      AUTH_RATE_LIMIT_POLICIES.otpLogin,
      request({ account: 'alice' }),
    );
    expect(
      policy.rules.find((rule) => rule.subject.type === 'ip-prefix64')?.subject
        .key,
    ).toBe('ip6-prefix64:2001:db8:1:2::/64');
  });

  it('enforces IPv4 and its IPv4-mapped IPv6 representation as one exact-IP bucket', () => {
    const rateLimits = new RateLimitService();
    const registryUnderTest = enforcingRegistry(rateLimits);
    for (let index = 0; index < 10; index++) {
      expect(
        rateLimits.evaluate(
          registryUnderTest.build(
            AUTH_RATE_LIMIT_POLICIES.passwordLogin,
            request({ account: `account-${index}` }, undefined, '192.0.2.10'),
          ),
          0,
        ).allowed,
      ).toBe(true);
    }
    expect(
      rateLimits.evaluate(
        registryUnderTest.build(
          AUTH_RATE_LIMIT_POLICIES.passwordLogin,
          request({ account: 'last' }, undefined, '::ffff:192.0.2.10'),
        ),
        0,
      ).allowed,
    ).toBe(false);
  });

  it('enforces rotating IPv6 addresses through their shared /64 bucket', () => {
    const rateLimits = new RateLimitService();
    const registryUnderTest = enforcingRegistry(rateLimits);
    for (let index = 1; index <= 10; index++) {
      expect(
        rateLimits.evaluate(
          registryUnderTest.build(
            AUTH_RATE_LIMIT_POLICIES.otpLogin,
            request(
              { account: `account-${index}` },
              undefined,
              `2001:db8:1:2::${index}`,
            ),
          ),
          0,
        ).allowed,
      ).toBe(true);
    }
    expect(
      rateLimits.evaluate(
        registryUnderTest.build(
          AUTH_RATE_LIMIT_POLICIES.otpLogin,
          request({ account: 'last' }, undefined, '2001:db8:1:2::ffff'),
        ),
        0,
      ).allowed,
    ).toBe(false);
  });
});
