import { beforeAll, describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';

process.env.SOMS_DOMAIN = 'local.example';

let DiscoveryService: typeof import('./discovery.service.js').DiscoveryService;

beforeAll(async () => {
  ({ DiscoveryService } = await import('./discovery.service.js'));
}, 30_000);

function makeService(options: {
  pinned: boolean;
  cachedKeys: Array<{ keyId: string; publicKey: string }>;
}) {
  const updateSet = vi.fn();
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  updateSet.mockReturnValue({ where: updateWhere });
  const eventValues = vi.fn().mockResolvedValue(undefined);
  const cacheConflictUpdate = vi.fn().mockResolvedValue(undefined);
  const cacheConflict = vi
    .fn()
    .mockReturnValue({ onConflictDoUpdate: cacheConflictUpdate });
  const insert = vi.fn((table: { keyId?: unknown }) => ({
    values: table.keyId ? cacheConflict : eventValues,
  }));
  const tx = {
    query: {
      federatedPeer: {
        findFirst: vi.fn().mockResolvedValue({
          domain: 'peer.example',
          trustLevel: 'trusted',
          identityPinnedAt: options.pinned ? new Date() : null,
        }),
      },
      s2SKeyCache: {
        findMany: vi.fn().mockResolvedValue(options.cachedKeys),
      },
    },
    update: vi.fn().mockReturnValue({ set: updateSet }),
    insert,
  };
  const database = {
    db: {
      transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
    },
  };
  const keypair = { getStatus: () => ({ available: true }) };
  return {
    service: new DiscoveryService(database as never, keypair as never),
    updateSet,
    eventValues,
    cacheConflictUpdate,
  };
}

const key = {
  keyId: 'peer.example/key-1',
  ed25519: Buffer.alloc(32, 7).toString('base64'),
};

describe('DiscoveryService single-key continuity', () => {
  it('refreshes only fetchedAt when the pinned key is unchanged', async () => {
    const { service, updateSet, cacheConflictUpdate } = makeService({
      pinned: true,
      cachedKeys: [{ keyId: key.keyId, publicKey: key.ed25519 }],
    });

    await service.cacheKeys('peer.example', [key]);

    expect(updateSet).not.toHaveBeenCalled();
    expect(cacheConflictUpdate).toHaveBeenCalledWith({
      target: expect.any(Array),
      set: { fetchedAt: expect.any(Date) },
    });
  });

  it('locks a pinned peer instead of overwriting the same keyId', async () => {
    const { service, updateSet, eventValues, cacheConflictUpdate } =
      makeService({
        pinned: true,
        cachedKeys: [
          {
            keyId: key.keyId,
            publicKey: Buffer.alloc(32, 8).toString('base64'),
          },
        ],
      });

    await expect(
      service.cacheKeys('peer.example', [key]),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
    });
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ trustLevel: 'identity_lost' }),
    );
    expect(eventValues).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'identity_lost' }),
    );
    expect(cacheConflictUpdate).not.toHaveBeenCalled();
  });

  it('rejects a second published key for a pinned peer', async () => {
    const { service, updateSet } = makeService({
      pinned: true,
      cachedKeys: [{ keyId: key.keyId, publicKey: key.ed25519 }],
    });

    await expect(
      service.cacheKeys('peer.example', [
        key,
        {
          keyId: 'peer.example/key-2',
          ed25519: Buffer.alloc(32, 9).toString('base64'),
        },
      ]),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
    });
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ trustLevel: 'identity_lost' }),
    );
  });
});
