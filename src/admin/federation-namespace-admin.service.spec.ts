import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { FederationNamespaceAdminService } from './federation-namespace-admin.service.js';

describe('FederationNamespaceAdminService', () => {
  it('lists all namespaces for a peer', async () => {
    const rows = [
      {
        id: 12,
        domain: 'peer.example',
        rootKeyFingerprint: 'sha256:abc',
        rootPublicKey: 'root',
        peerAssignedLocalNamespaceId: 9,
        identityPinnedAt: new Date(),
        createdAt: new Date(),
        retiredAt: null,
        active: true,
      },
    ];
    const database = {
      db: {
        execute: vi.fn().mockResolvedValue({ rows }),
      },
    };
    const service = new FederationNamespaceAdminService(database as never);

    await expect(service.list('Peer.Example.')).resolves.toBe(rows);
    expect(database.db.execute).toHaveBeenCalledOnce();
  });

  it('switches the active namespace and requires peer acceptance to converge again', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ activeNamespaceId: 12 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 13,
            rootKeyFingerprint: 'sha256:def',
            rootPublicKey: 'root',
            identityPinnedAt: new Date(),
            retiredAt: null,
          },
        ],
      })
      .mockResolvedValue({ rows: [] });
    const tx = { execute };
    const database = {
      db: {
        transaction: vi.fn((run: (value: typeof tx) => unknown) => run(tx)),
      },
    };
    const service = new FederationNamespaceAdminService(database as never);

    await expect(service.setActive('Peer.Example.', 13)).resolves.toEqual({
      domain: 'peer.example',
      activeNamespaceId: 13,
      status: 'active_namespace_switched',
    });
    expect(execute).toHaveBeenCalledTimes(5);
    expect(database.db.transaction).toHaveBeenCalledOnce();
  });

  it('rejects switching to a namespace without pinned identity evidence', async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ activeNamespaceId: 12 }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 13,
              rootKeyFingerprint: null,
              rootPublicKey: null,
              identityPinnedAt: null,
            },
          ],
        }),
    };
    const database = {
      db: {
        transaction: vi.fn((run: (value: typeof tx) => unknown) => run(tx)),
      },
    };
    const service = new FederationNamespaceAdminService(database as never);

    await expect(service.setActive('peer.example', 13)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
    });
  });
});
