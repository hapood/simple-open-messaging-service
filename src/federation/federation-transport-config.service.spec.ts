import { describe, expect, it, vi } from 'vitest';
import { FederationTransportConfigService } from './federation-transport-config.service.js';

const configured = {
  keyCacheTtlSec: 3600,
  connectTimeoutSec: 10,
  callTimeoutSec: 30,
  mediaChunkBytes: 1024 * 1024,
  mediaChunkTimeoutSec: 90,
  mediaMaxChunkRetries: 3,
};

function database(stored?: unknown) {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  return {
    value: {
      db: {
        query: {
          systemSetting: {
            findFirst: vi
              .fn()
              .mockResolvedValue(
                stored === undefined
                  ? undefined
                  : { value: JSON.stringify(stored) },
              ),
          },
        },
        insert,
      },
    },
    insert,
    values,
    onConflictDoUpdate,
  };
}

describe('FederationTransportConfigService', () => {
  it('uses safe defaults when no setting exists', async () => {
    const db = database();
    const service = new FederationTransportConfigService(db.value as never);
    await service.onModuleInit();
    expect(service.get()).toMatchObject({
      keyCacheTtlSec: 21_600,
      mediaChunkBytes: 8 * 1024 * 1024,
      mediaMaxChunkRetries: 5,
    });
  });

  it('loads and hot-applies a complete persisted policy', async () => {
    const db = database(configured);
    const service = new FederationTransportConfigService(db.value as never);
    await service.onModuleInit();
    expect(service.get()).toEqual(configured);

    const next = { ...configured, callTimeoutSec: 45 };
    await expect(service.set(next)).resolves.toEqual(next);
    expect(service.get()).toEqual(next);
    expect(db.onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it('rejects partial, unknown, and out-of-range settings', async () => {
    const service = new FederationTransportConfigService(
      database().value as never,
    );
    await expect(service.set({ callTimeoutSec: 12 })).rejects.toThrow(
      'exactly the supported fields',
    );
    await expect(
      service.set({ ...configured, unsupported: 1 }),
    ).rejects.toThrow('exactly the supported fields');
    await expect(
      service.set({ ...configured, mediaChunkBytes: 64 }),
    ).rejects.toThrow('mediaChunkBytes');
  });
});
