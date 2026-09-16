import { describe, expect, it, vi } from 'vitest';
import { GroupAuthoredMembershipIntentService } from './group-authored-membership-intent.service.js';
import { MemberAuthoredGroupMembershipIntentService } from './member-authored-group-membership-intent.service.js';

describe('query-denied authored membership revocation', () => {
  it('calls the group-authored writer with the captured group generation', async () => {
    const writeGroupRelationshipIntentInTx = vi
      .fn()
      .mockResolvedValue(new Map([['peer.test', 3n]]));
    const pushStateFeedDomains = vi.fn().mockResolvedValue(undefined);
    const service = new GroupAuthoredMembershipIntentService({
      database: {
        db: { transaction: (run: (tx: unknown) => unknown) => run('tx') },
      } as never,
      clientFeed: { notifyFeedUpdates: vi.fn() } as never,
      peerFeed: {} as never,
      federation: { pushStateFeedDomains } as never,
      relationshipMutations: { writeGroupRelationshipIntentInTx } as never,
    });

    await expect(
      service.executeQueryDeniedRevocation({
        threadId: 12,
        group: { account: '!group', domain: 'local', namespaceId: 0 },
        member: {
          account: 'remote',
          domain: 'peer.test',
          namespaceId: 5,
        },
        expectedAuthorizationEpoch: 8,
      }),
    ).resolves.toEqual({ status: 'APPLIED' });
    expect(writeGroupRelationshipIntentInTx).toHaveBeenCalledWith(
      'tx',
      12,
      { account: 'remote', domain: 'peer.test', namespaceId: 5 },
      '',
      'REVOKED',
      [],
      undefined,
      {
        expectedAuthorization: {
          epoch: 8,
          group: { account: '!group', domain: 'local', namespaceId: 0 },
        },
      },
    );
    expect(pushStateFeedDomains).toHaveBeenCalledOnce();
  });

  it('calls the member-authored writer and returns a normal no-op on a stale generation', async () => {
    const writeMemberRelationshipIntentInTx = vi
      .fn()
      .mockResolvedValue(new Map());
    const service = new MemberAuthoredGroupMembershipIntentService({
      database: {
        db: { transaction: (run: (tx: unknown) => unknown) => run('tx') },
      } as never,
      clientFeed: { notifyFeedUpdates: vi.fn() } as never,
      relationshipMutations: { writeMemberRelationshipIntentInTx } as never,
      federation: {
        ourDomain: 'local.test',
        pushStateFeedDomains: vi.fn(),
      },
    });

    await expect(
      service.executeQueryDeniedRevocation({
        threadId: 12,
        group: {
          account: '!group',
          domain: 'peer.test',
          namespaceId: 5,
        },
        memberUserId: 7,
        expectedAuthorizationEpoch: 8,
      }),
    ).resolves.toEqual({
      status: 'NO_OP',
      reason: 'STALE_OR_ALREADY_REVOKED',
    });
    expect(writeMemberRelationshipIntentInTx).toHaveBeenCalledWith(
      'tx',
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
            domain: 'peer.test',
            namespaceId: 5,
          },
        },
      },
    );
  });
});
