import { describe, expect, it, vi } from 'vitest';
import { FederationService } from './federation.service.js';

describe('addressed friendship acceptance', () => {
  it('retains the remote zero snapshot while authoring the local confirmation', async () => {
    const tx = {};
    const remoteIntent = {
      status: 'REQUESTED',
      profileRev: 0,
      note: '',
      requestedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
    };
    const remoteWrite = vi.fn();
    const localWrite = vi.fn(async () => new Map([['peer.test', 1n]]));
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService;
    Object.assign(service, {
      database: {
        db: { transaction: async (run: (tx: object) => unknown) => run(tx) },
      },
      namespaces: {
        captureActiveInTx: vi.fn(async () => ({ namespaceId: 7 })),
      },
      relationshipIntents: {
        readP2PRelationshipByAddressInTx: vi.fn(async () => ({ remoteIntent })),
        applyRemoteP2PIntentInTx: remoteWrite,
      },
      relationshipMutations: { writeP2PIntentInTx: localWrite },
      clientStateFeed: { notifyFeedUpdates: vi.fn() },
    });
    await expect(
      service.acceptAddressedFriendRequest(3, {
        account: 'alice',
        domain: 'peer.test',
      }),
    ).resolves.toEqual(new Map([['peer.test', 1n]]));
    expect(remoteWrite).not.toHaveBeenCalled();
    expect(localWrite).toHaveBeenCalledWith(
      tx,
      3,
      { account: 'alice', domain: 'peer.test', namespaceId: 7 },
      true,
      '',
      [],
    );
  });
});
