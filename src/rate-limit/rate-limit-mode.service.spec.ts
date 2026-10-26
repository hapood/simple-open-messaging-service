import { describe, expect, it } from 'vitest';
import { RateLimitModeService } from './rate-limit-mode.service.js';

describe('RateLimitModeService', () => {
  it('uses safe built-in defaults in-memory', () => {
    const service = new RateLimitModeService();
    expect(service.forPolicy('auth.password.login')).toMatchObject({
      mode: 'enforce',
      exactIp: { ratePerSecond: 1, burst: 10, enforce: true },
      account: { ratePerSecond: 0.2, burst: 5, enforce: false },
    });
    expect(service.monitoringConfig()).toHaveLength(6);
  });

  it('applies configuration in-memory without database persistence', () => {
    const service = new RateLimitModeService();
    const configuration = service.monitoringConfig();
    configuration[0] = {
      ...configuration[0],
      mode: 'shadow',
      buckets: configuration[0].buckets.map((bucket) => ({
        ...bucket,
        ratePerSecond: 2,
        burst: 12,
      })),
    };

    service.setConfiguration(configuration);

    expect(service.forPolicy(configuration[0].policy).mode).toBe('shadow');
    expect(service.forPolicy(configuration[0].policy).exactIp).toMatchObject({
      ratePerSecond: 2,
      burst: 12,
    });
  });

  it('rejects incomplete or unsafe configurations', () => {
    const service = new RateLimitModeService();
    const configuration = service.monitoringConfig();

    expect(() => service.setConfiguration(configuration.slice(1))).toThrow(
      'must include every authentication policy',
    );
    configuration[0].buckets[0].burst = 0;
    expect(() => service.setConfiguration(configuration)).toThrow(
      'invalid rate or burst',
    );
  });

  it('throws for an unknown policy', () => {
    const service = new RateLimitModeService();
    expect(() => service.forPolicy('missing')).toThrow(
      'unknown authentication rate-limit policy',
    );
  });
});
