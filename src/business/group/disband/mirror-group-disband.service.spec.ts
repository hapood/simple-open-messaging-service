import { describe, expect, it, vi } from 'vitest';
import { MirrorGroupDisbandService } from './mirror-group-disband.service.js';

vi.mock('../../shared/locks/account-business-lock.js', () => ({
  lockBusinessAccountsInTx: vi.fn(),
}));
vi.mock('../../shared/locks/relationship-pair-business-lock.js', () => ({
  lockRelationshipPairsInTx: vi.fn(),
}));
vi.mock('../../shared/locks/thread-content-lock.js', () => ({
  requireGroupThreadContentLockUnderGroupInTx: vi.fn(),
}));

describe('MirrorGroupDisbandService', () => {
  it('does not let an old denial tombstone a reopened mirror generation', async () => {
    const execute = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          groupAccount: '!group',
          groupDomain: 'peer.test',
          namespaceId: 5,
          dissolvedAt: null,
          authorizationEpoch: 9,
          pairId: null,
          localMemberId: null,
        },
      ],
    });
    const service = new MirrorGroupDisbandService(
      {
        db: {
          transaction: (run: (tx: unknown) => unknown) => run({ execute }),
        },
      } as never,
      {} as never,
    );

    await expect(
      service.markDissolved({
        threadId: 31,
        groupAccount: '!group',
        peerDomain: 'peer.test',
        namespaceId: 5,
        expectedAuthorizationEpoch: 8,
      }),
    ).resolves.toEqual({ transitioned: false });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('stops an old member child after the mirror generation changes', async () => {
    const located = {
      groupAccount: '!group',
      groupDomain: 'peer.test',
      namespaceId: 5,
      dissolvedAt: new Date().toISOString(),
      authorizationEpoch: 10,
      pairId: '41',
      localMemberId: 7,
    };
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [located] })
      .mockResolvedValueOnce({
        rows: [
          {
            ...located,
            authorizationEpoch: 11,
          },
        ],
      });
    const service = new MirrorGroupDisbandService(
      {
        db: {
          transaction: (run: (tx: unknown) => unknown) => run({ execute }),
        },
      } as never,
      {} as never,
    );

    await expect(
      service.revokeMember({
        threadId: 31,
        memberUserId: {
          account: 'member',
          domain: 'local',
          namespaceId: 0,
        },
        expectedAuthorizationEpoch: 10,
      }),
    ).resolves.toEqual({ transitioned: false });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
