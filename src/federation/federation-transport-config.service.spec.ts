import { describe, expect, it, vi } from 'vitest';
import {
  FederationTransportConfigService,
  transportSettingKey,
  type FederationTransportConfig,
} from './federation-transport-config.service.js';

const configured: FederationTransportConfig = {
  keyCacheTtlSec: 3600,
  connectTimeoutSec: 10,
  requestIdleTimeoutSec: 30,
  mediaChunkBytes: 1024 * 1024,
  mediaMaxChunkRetries: 3,
};

function database(rows: Array<{ key: string; value: string }> = []) {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  const transaction = vi.fn(async (callback) => callback({ insert }));
  return {
    value: {
      db: {
        query: {
          systemSetting: {
            findMany: vi.fn().mockResolvedValue(rows),
          },
        },
        transaction,
        insert,
      },
    },
    insert,
    values,
    onConflictDoUpdate,
    transaction,
  };
}

describe('FederationTransportConfigService', () => {
  it('uses safe defaults when no settings exist', async () => {
    const db = database();
    const service = new FederationTransportConfigService(db.value as never);
    await service.onModuleInit();
    expect(service.get()).toMatchObject({
      keyCacheTtlSec: 21_600,
      connectTimeoutSec: 12,
      requestIdleTimeoutSec: 30,
      mediaChunkBytes: 8 * 1024 * 1024,
      mediaMaxChunkRetries: 5,
    });
  });

  it('loads and hot-applies individual persisted keys', async () => {
    const rows = Object.entries(configured).map(([k, v]) => ({
      key: transportSettingKey(k as keyof FederationTransportConfig),
      value: String(v),
    }));
    const db = database(rows);
    const service = new FederationTransportConfigService(db.value as never);
    await service.onModuleInit();
    expect(service.get()).toEqual(configured);

    const next = { ...configured, requestIdleTimeoutSec: 45 };
    await expect(service.set(next)).resolves.toEqual(next);
    expect(service.get()).toEqual(next);
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(db.onConflictDoUpdate).toHaveBeenCalledTimes(5);
  });

  it('falls back to in-memory default for any missing, corrupted, or out-of-range key', async () => {
    const rows = [
      { key: transportSettingKey('keyCacheTtlSec'), value: 'invalid' },
      { key: transportSettingKey('connectTimeoutSec'), value: '-5' },
      { key: transportSettingKey('requestIdleTimeoutSec'), value: '45' },
      // mediaChunkBytes & mediaMaxChunkRetries absent
    ];
    const db = database(rows);
    const service = new FederationTransportConfigService(db.value as never);
    await service.onModuleInit();
    expect(service.get()).toEqual({
      keyCacheTtlSec: 21_600, // fallback
      connectTimeoutSec: 12, // fallback
      requestIdleTimeoutSec: 45, // valid row loaded
      mediaChunkBytes: 8 * 1024 * 1024, // fallback
      mediaMaxChunkRetries: 5, // fallback
    });
  });

  it('rejects partial, unknown, and out-of-range settings when saving', async () => {
    const service = new FederationTransportConfigService(
      database().value as never,
    );
    await expect(service.set({ requestIdleTimeoutSec: 12 })).rejects.toThrow(
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
