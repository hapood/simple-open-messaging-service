import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { FederationResetService } from './federation-reset.service.js';

describe('FederationResetService', () => {
  it('previews the retained history owned by the active namespace', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 12,
            trustLevel: 'halted',
            haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
            haltReason: 'pinned root changed',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            foreignUserCount: 3,
            groupMetaMemberFactCount: 4,
            affectedThreadCount: 2,
            authoredMessageCount: 9,
            relationshipCount: 1,
          },
        ],
      });
    const tx = { execute };
    const database = {
      db: {
        transaction: vi.fn((run: (value: typeof tx) => unknown) => run(tx)),
      },
    };
    const service = new FederationResetService(
      database as never,
      {} as never,
      {
        recordNamespaceChangeInTx: vi.fn().mockResolvedValue(1n),
        recordClientChangeInTx: vi.fn().mockResolvedValue(1n),
      } as never,
      { notifyProfileNamespaceChange: vi.fn() } as never,
    );

    await expect(service.preview('Peer.Example.')).resolves.toMatchObject({
      domain: 'peer.example',
      activeNamespaceId: 12,
      haltReason: 'pinned root changed',
      foreignUserCount: 3,
      groupMetaMemberFactCount: 4,
      affectedThreadCount: 2,
      authoredMessageCount: 9,
      relationshipCount: 1,
    });
    expect(database.db.transaction).toHaveBeenCalledOnce();
  });

  it('rejects reset unless an identity-mismatch halted peer has an active namespace', async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          {
            activeNamespaceId: null,
            trustLevel: 'unrecognized',
            haltCode: null,
            haltReason: null,
          },
        ],
      }),
    };
    const database = {
      db: {
        transaction: vi.fn((run: (value: typeof tx) => unknown) => run(tx)),
      },
    };
    const service = new FederationResetService(
      database as never,
      {} as never,
      {
        recordNamespaceChangeInTx: vi.fn().mockResolvedValue(1n),
        recordClientChangeInTx: vi.fn().mockResolvedValue(1n),
      } as never,
      { notifyProfileNamespaceChange: vi.fn() } as never,
    );

    await expect(service.preview('peer.example')).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
    });
  });

  it.each([false, true])(
    'commits namespace retirement atomically (rollback=%s)',
    async (rollback) => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              activeNamespaceId: 12,
              trustLevel: 'halted',
              haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
            },
          ],
        })
        .mockResolvedValue({ rows: [] });
      const tx = { execute };
      const database = {
        db: {
          transaction: vi.fn(async (run: (value: typeof tx) => unknown) => {
            const result = await run(tx);
            if (rollback) throw new Error('commit failed');
            return result;
          }),
        },
      };
      const namespaces = {
        retireActiveInTx: vi.fn().mockResolvedValue({ namespaceId: 12 }),
      };
      const service = new FederationResetService(
        database as never,
        namespaces as never,
        {
          recordNamespaceChangeInTx: vi.fn().mockResolvedValue(1n),
          recordClientChangeInTx: vi.fn().mockResolvedValue(1n),
        } as never,
        { notifyProfileNamespaceChange: vi.fn() } as never,
      );

      if (rollback) {
        await expect(
          service.start('peer.example', 'peer.example'),
        ).rejects.toThrow('commit failed');
        return;
      }

      await expect(
        service.start('Peer.Example.', 'peer.example'),
      ).resolves.toEqual({
        domain: 'peer.example',
        archivedNamespaceId: 12,
        activeNamespaceId: null,
        status: 'reset',
        clientChangeId: 1n,
      });
      expect(namespaces.retireActiveInTx).toHaveBeenCalledWith(
        tx,
        'peer.example',
      );
    },
  );
});
