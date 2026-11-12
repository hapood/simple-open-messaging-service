import { describe, expect, it, vi } from 'vitest';
import { ProfileNamespaceService } from './profile-namespace.service.js';
import {
  identityNamespace,
  profileNamespace,
  profileNamespaceFeedHead,
} from '../database/schema.js';

const ROOT_KEY = 'k'.repeat(44);
function harness(
  options: {
    cacheRow?: Record<string, unknown>;
    registryRow?: Record<string, unknown>;
  } = {},
) {
  const select = vi.fn(() => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => {
          if (table === profileNamespaceFeedHead) return [{ feedEndId: 7n }];
          if (table === identityNamespace)
            return [{ feedEndId: 7n, ...options.registryRow }];
          if (table === profileNamespace)
            return options.cacheRow ? [options.cacheRow] : [];
          throw new Error('unexpected table');
        },
      }),
    }),
  }));
  const insert = vi.fn(() => ({
    values: () => ({ onConflictDoNothing: async () => [] }),
  }));
  const database = {
    db: {
      select,
      insert,
      query: {
        identityNamespace: { findFirst: async () => ({ domain: 'soms.test' }) },
      },
    },
  };
  return {
    service: new ProfileNamespaceService(
      database as never,
      { getRootPublicKeyB64: () => ROOT_KEY } as never,
    ),
    insert,
  };
}

describe('ProfileNamespaceService.readOne', () => {
  it('reads the authoritative local self binding without scheduler state or a local sentinel', async () => {
    const { service, insert } = harness();
    expect(
      await service.readOne({ publisherNamespaceId: 0, profileNamespaceId: 0 }),
    ).toEqual({
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      domain: 'soms.test',
      rootPublicKey: ROOT_KEY,
      updateFeedId: 7,
      expired: false,
      status: 'ACTIVE',
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('reads local publisher namespace subjects from the authoritative registry', async () => {
    const { service } = harness({
      registryRow: {
        domain: 'peer.test',
        rootPublicKey: ROOT_KEY,
        retiredAt: null,
        active: true,
      },
    });
    expect(
      await service.readOne({
        publisherNamespaceId: 0,
        profileNamespaceId: 12,
      }),
    ).toMatchObject({
      publisherNamespaceId: 0,
      profileNamespaceId: 12,
      domain: 'peer.test',
      expired: false,
      updateFeedId: 7,
    });
  });

  it('preserves the authoritative archived result for a retired local namespace', async () => {
    const { service } = harness({
      registryRow: { retiredAt: new Date(), active: false },
    });
    expect(
      await service.readOne({
        publisherNamespaceId: 0,
        profileNamespaceId: 12,
      }),
    ).toMatchObject({
      status: 'ARCHIVED',
      domain: null,
      rootPublicKey: null,
      expired: true,
    });
  });

  it.each([0, 5])(
    'reads a foreign cached subject %i without assigning fetch state',
    async (profileNamespaceId) => {
      const cacheRow = {
        publisherNamespaceId: 12,
        profileNamespaceId,
        domain: 'peer.test',
        rootPublicKey: ROOT_KEY,
        updateFeedId: 3n,
        expired: false,
        status: 'ACTIVE',
      };
      const { service, insert } = harness({ cacheRow });
      expect(
        await service.readOne({ publisherNamespaceId: 12, profileNamespaceId }),
      ).toEqual({ ...cacheRow, updateFeedId: 3 });
      expect(insert).not.toHaveBeenCalled();
    },
  );

  it.each([0, 9])(
    'plants a missing subject %i tomb but returns null, not PENDING',
    async (profileNamespaceId) => {
      const { service, insert } = harness();
      expect(
        await service.readOne({ publisherNamespaceId: 12, profileNamespaceId }),
      ).toBeNull();
      expect(insert).toHaveBeenCalledOnce();
    },
  );

  it('returns an expired placeholder as cache data without claiming READY or reinserting it', async () => {
    const { service, insert } = harness({
      cacheRow: {
        publisherNamespaceId: 12,
        profileNamespaceId: 6,
        domain: null,
        rootPublicKey: null,
        updateFeedId: 2n,
        expired: true,
        status: 'ACTIVE',
      },
    });
    expect(
      await service.readOne({
        publisherNamespaceId: 12,
        profileNamespaceId: 6,
      }),
    ).toMatchObject({
      expired: true,
      domain: null,
      updateFeedId: 2,
      status: 'ACTIVE',
    });
    expect(insert).not.toHaveBeenCalled();
  });
});
