import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service.js';
import type { RateLimitPolicy } from './rate-limit.types.js';

describe('RateLimitService', () => {
  const services: RateLimitService[] = [];

  afterEach(() => {
    for (const service of services) service.onModuleDestroy();
    services.length = 0;
  });

  function createService(): RateLimitService {
    const service = new RateLimitService();
    services.push(service);
    return service;
  }

  function policy(mode: 'disabled' | 'shadow' | 'enforce'): RateLimitPolicy {
    return {
      name: 'auth.login',
      mode,
      rules: [
        {
          subject: { type: 'ip-exact', key: 'ip6:2001:db8::1' },
          ratePerSecond: 1,
          burst: 1,
        },
      ],
    };
  }

  it('records a shadow block but never rejects the effective request', () => {
    const service = createService();
    service.evaluate(policy('shadow'), 0);
    expect(service.evaluate(policy('shadow'), 0)).toMatchObject({
      allowed: true,
      wouldBlock: true,
      retryAfterMs: 1_000,
    });
    expect(service.snapshotStats()).toEqual([
      {
        policy: 'auth.login',
        mode: 'shadow',
        evaluated: 2,
        allowed: 1,
        wouldBlock: 1,
        blocked: 0,
        observeOnlyExceeded: 0,
        maxRetryAfterMs: 1_000,
      },
    ]);
  });

  it('requires every independent subject rule to pass in enforce mode', () => {
    const service = createService();
    const configured: RateLimitPolicy = {
      name: 'message.send',
      mode: 'enforce',
      rules: [
        {
          subject: { type: 'user', key: '42' },
          ratePerSecond: 1,
          burst: 1,
        },
        {
          subject: { type: 'ip-prefix64', key: 'ip6-prefix64:2001:db8::/64' },
          ratePerSecond: 10,
          burst: 10,
        },
      ],
    };
    service.evaluate(configured, 0);
    expect(service.evaluate(configured, 0)).toMatchObject({
      allowed: false,
      wouldBlock: true,
    });
  });

  it('does not consume buckets for a disabled policy', () => {
    const service = createService();
    expect(service.evaluate(policy('disabled'), 0)).toMatchObject({
      allowed: true,
      wouldBlock: false,
      rules: [],
    });
    expect(service.snapshotStats()).toEqual([]);
    expect(service.evaluate(policy('enforce'), 0).allowed).toBe(true);
  });

  it('observes a non-enforcing account rule without rejecting the request', () => {
    const service = createService();
    const configured: RateLimitPolicy = {
      name: 'auth.login',
      mode: 'enforce',
      rules: [
        {
          subject: { type: 'account', key: 'private-hash' },
          ratePerSecond: 1,
          burst: 1,
          enforce: false,
        },
      ],
    };
    service.evaluate(configured, 0);
    expect(service.evaluate(configured, 0)).toMatchObject({
      allowed: true,
      wouldBlock: true,
      retryAfterMs: 0,
    });
    expect(service.snapshotStats()).toEqual([
      expect.objectContaining({
        allowed: 2,
        blocked: 0,
        observeOnlyExceeded: 1,
      }),
    ]);
  });

  it('never exposes subject keys in observability output', () => {
    const service = createService();
    service.evaluate(policy('shadow'), 0);
    const serialized = JSON.stringify(service.snapshotStats());
    expect(serialized).not.toContain('2001:db8');
    expect(serialized).not.toContain('ip-exact');
  });

  it('emits one aggregate summary and resets the interval', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const service = createService();
    service.evaluate(policy('shadow'), 0);
    service.flushSummary();
    service.flushSummary();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      event: 'rate_limit_summary',
      policies: [
        {
          policy: 'auth.login',
          mode: 'shadow',
          evaluated: 1,
          allowed: 1,
          wouldBlock: 0,
          blocked: 0,
          observeOnlyExceeded: 0,
          maxRetryAfterMs: 0,
        },
      ],
    });
    expect(service.snapshotStats()).toEqual([]);
    log.mockRestore();
  });

  it('counts enforced blocks and keeps the longest retry delay', () => {
    const service = createService();
    const configured: RateLimitPolicy = {
      name: 'auth.login',
      mode: 'enforce',
      rules: [
        {
          subject: { type: 'ip-exact', key: 'ip4:192.0.2.1' },
          ratePerSecond: 1,
          burst: 1,
        },
        {
          subject: { type: 'user', key: 'private-hash' },
          ratePerSecond: 0.5,
          burst: 1,
        },
      ],
    };
    service.evaluate(configured, 0);
    service.evaluate(configured, 0);
    expect(service.snapshotStats()).toEqual([
      expect.objectContaining({
        policy: 'auth.login',
        mode: 'enforce',
        evaluated: 2,
        allowed: 1,
        wouldBlock: 0,
        blocked: 1,
        maxRetryAfterMs: 2_000,
      }),
    ]);
  });
});
