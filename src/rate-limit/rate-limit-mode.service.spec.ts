import { describe, expect, it, vi } from 'vitest';
import { RateLimitModeService } from './rate-limit-mode.service.js';
import type { DatabaseService } from '../database/database.service.js';

function databaseStub(stored?: string) {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  return {
    database: {
      db: {
        query: {
          systemSetting: {
            findFirst: vi
              .fn()
              .mockResolvedValue(
                stored
                  ? { key: 'rateLimit:authPolicies', value: stored }
                  : undefined,
              ),
          },
        },
        insert,
      },
    } as unknown as DatabaseService,
    insert,
    values,
    onConflictDoUpdate,
  };
}

describe('RateLimitModeService', () => {
  it('uses safe built-in defaults when no database setting exists', async () => {
    const stub = databaseStub();
    const service = new RateLimitModeService(stub.database);
    await service.onModuleInit();

    expect(service.forPolicy('auth.password.login')).toMatchObject({
      mode: 'enforce',
      exactIp: { ratePerSecond: 1, burst: 10, enforce: true },
      account: { ratePerSecond: 0.2, burst: 5, enforce: false },
    });
    expect(service.monitoringConfig()).toHaveLength(6);
  });

  it('persists a complete configuration and applies it immediately', async () => {
    const stub = databaseStub();
    const service = new RateLimitModeService(stub.database);
    await service.onModuleInit();
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

    await service.setConfiguration(configuration);

    expect(service.forPolicy(configuration[0].policy).mode).toBe('shadow');
    expect(service.forPolicy(configuration[0].policy).exactIp).toMatchObject({
      ratePerSecond: 2,
      burst: 12,
    });
    expect(stub.insert).toHaveBeenCalledOnce();
    expect(stub.onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it('loads persisted configuration on startup', async () => {
    const initial = new RateLimitModeService();
    const configuration = initial.monitoringConfig();
    configuration[1] = { ...configuration[1], mode: 'disabled' };
    const stored = JSON.stringify(configuration);
    const stub = databaseStub(stored);
    const service = new RateLimitModeService(stub.database);

    await service.onModuleInit();

    expect(service.forPolicy(configuration[1].policy).mode).toBe('disabled');
  });

  it('rejects incomplete or unsafe configurations', async () => {
    const stub = databaseStub();
    const service = new RateLimitModeService(stub.database);
    await service.onModuleInit();
    const configuration = service.monitoringConfig();

    await expect(
      service.setConfiguration(configuration.slice(1)),
    ).rejects.toThrow('must include every authentication policy');
    configuration[0].buckets[0].burst = 0;
    await expect(service.setConfiguration(configuration)).rejects.toThrow(
      'invalid rate or burst',
    );
    expect(stub.insert).not.toHaveBeenCalled();
  });

  it('throws for an unknown policy', () => {
    const service = new RateLimitModeService();
    expect(() => service.forPolicy('missing')).toThrow(
      'unknown authentication rate-limit policy',
    );
  });
});
