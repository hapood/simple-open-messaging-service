import { describe, expect, it, vi } from 'vitest';
import { GroupAuthoredMembershipIntentService } from './group-authored-membership-intent.service.js';
import { MemberAuthoredGroupMembershipIntentService } from './member-authored-group-membership-intent.service.js';

function transaction() {
  const tx = {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
  return {
    tx,
    database: {
      db: { transaction: (run: (value: typeof tx) => unknown) => run(tx) },
    },
  };
}

describe('query-denied authored membership revocation', () => {
  it('calls the group-authored writer with the captured group generation', async () => {
    const target = transaction();
    const writeGroupRelationshipIntentInTx = vi
      .fn()
      .mockResolvedValue(new Map([['peer.test', 3n]]));
    const pushStateFeedNamespaces = vi.fn().mockResolvedValue(undefined);
    const service = new GroupAuthoredMembershipIntentService({
      database: target.database as never,
      clientFeed: { notifyFeedUpdates: vi.fn() } as never,
      peerFeed: {} as never,
      federation: { pushStateFeedNamespaces } as never,
      relationshipMutations: { writeGroupRelationshipIntentInTx } as never,
    });

    await expect(
      service.executeQueryDeniedRevocation({
        threadId: 12,
        group: { account: '!group', namespaceId: 0 },
        member: {
          account: 'remote',
          namespaceId: 5,
        },
        expectedAuthorizationEpoch: 8,
      }),
    ).resolves.toEqual({ status: 'APPLIED' });
    expect(target.tx.execute).toHaveBeenCalledOnce();
    expect(writeGroupRelationshipIntentInTx).toHaveBeenCalledWith(
      target.tx,
      12,
      { account: 'remote', namespaceId: 5 },
      '',
      'REVOKED',
      [],
      undefined,
      {
        expectedAuthorization: {
          epoch: 8,
          group: { account: '!group', namespaceId: 0 },
        },
      },
    );
    expect(pushStateFeedNamespaces).toHaveBeenCalledOnce();
  });

  it('calls the member-authored writer and returns a normal no-op on a stale generation', async () => {
    const target = transaction();
    const writeMemberRelationshipIntentInTx = vi
      .fn()
      .mockResolvedValue(new Map());
    const service = new MemberAuthoredGroupMembershipIntentService({
      database: target.database as never,
      clientFeed: { notifyFeedUpdates: vi.fn() } as never,
      relationshipMutations: { writeMemberRelationshipIntentInTx } as never,
      federation: {
        pushStateFeedNamespaces: vi.fn(),
      },
    });

    await expect(
      service.executeQueryDeniedRevocation({
        threadId: 12,
        group: {
          account: '!group',
          namespaceId: 5,
        },
        memberUserId: 7,
        expectedAuthorizationEpoch: 8,
      }),
    ).resolves.toEqual({
      status: 'NO_OP',
      reason: 'STALE_OR_ALREADY_REVOKED',
    });
    expect(target.tx.execute).toHaveBeenCalledOnce();
    expect(writeMemberRelationshipIntentInTx).toHaveBeenCalledWith(
      target.tx,
      12,
      7,
      'REVOKED',
      [],
      '',
      undefined,
      {
        expectedAuthorization: {
          epoch: 8,
          group: {
            account: '!group',
            namespaceId: 5,
          },
        },
      },
    );
  });
});
