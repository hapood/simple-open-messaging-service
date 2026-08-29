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
            activeNamespaceId: 12,
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
            participantCount: 4,
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
      {} as never,
    );

    await expect(service.preview('Peer.Example.')).resolves.toMatchObject({
      domain: 'peer.example',
      activeNamespaceId: 12,
      haltReason: 'pinned root changed',
      foreignUserCount: 3,
      participantCount: 4,
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
      {} as never,
    );

    await expect(service.preview('peer.example')).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
    });
  });

  it('retires the namespace without deleting history and publishes the namespace change', async () => {
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
      .mockResolvedValueOnce({ rows: [{ userId: 7 }, { userId: 9 }] })
      .mockResolvedValue({ rows: [] });
    const tx = { execute };
    const database = {
      db: {
        transaction: vi.fn((run: (value: typeof tx) => unknown) => run(tx)),
      },
    };
    const namespaces = {
      retireActiveInTx: vi.fn().mockResolvedValue({ namespaceId: 12 }),
    };
    const clientStateFeed = {
      writeInTx: vi
        .fn()
        .mockResolvedValueOnce(31)
        .mockResolvedValueOnce(32),
      notifyFeedUpdates: vi.fn(),
    };
    const service = new FederationResetService(
      database as never,
      namespaces as never,
      clientStateFeed as never,
    );

    await expect(
      service.start('Peer.Example.', 'peer.example'),
    ).resolves.toEqual({
      domain: 'peer.example',
      archivedNamespaceId: 12,
      activeNamespaceId: null,
      status: 'reset',
    });
    expect(namespaces.retireActiveInTx).toHaveBeenCalledWith(
      tx,
      'peer.example',
    );
    expect(clientStateFeed.writeInTx).toHaveBeenCalledTimes(2);
    expect(clientStateFeed.writeInTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        namespaceId: 12,
        eventType: 'NAMESPACE_CHANGED',
        body: {
          domain: 'peer.example',
          previousNamespaceId: 12,
          activeNamespaceId: null,
        },
      }),
    );
    expect(clientStateFeed.notifyFeedUpdates).toHaveBeenCalledWith([
      { userId: 7, feedId: 31 },
      { userId: 9, feedId: 32 },
    ]);
  });
});
