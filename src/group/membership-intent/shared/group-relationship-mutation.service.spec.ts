import { describe, expect, it, vi } from 'vitest';
import { GroupRelationshipMutationService } from './group-relationship-mutation.service.js';

process.env.SOMS_DOMAIN ??= 'chat.example';

function queryResult<T>(value: T) {
  const query: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'limit'])
    query[method] = vi.fn(() => query);
  query.then = (
    resolve: (result: T) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return query;
}

describe('GroupRelationshipMutationService', () => {
  it('passes the caller transaction through the group command lock', async () => {
    const tx = {
      select: vi.fn(() => queryResult([{ groupId: 9 }])),
    } as never;
    const relationshipIntents = {
      lockGroupMutationInTx: vi.fn().mockResolvedValue({
        id: 1n,
        threadLock: {},
      }),
    };
    const service = new GroupRelationshipMutationService(
      relationshipIntents as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.lockGroupMutationInTx(tx, 4, 7, [8]);

    expect(relationshipIntents.lockGroupMutationInTx).toHaveBeenCalledWith(tx, {
      threadId: 4,
      groupId: 9,
      memberUserId: 7,
      projectionUserIds: [8],
    });
  });

  it('applies request projections in the same caller transaction', async () => {
    const tx = {} as never;
    const projection = {
      writeEffectsInTx: vi.fn().mockResolvedValue(undefined),
    };
    const service = new GroupRelationshipMutationService(
      {} as never,
      projection as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await service.writeGroupRequestEffectsInTx(
      tx,
      4,
      7,
      'ACCEPTED',
      'INVITATION',
      false,
    );

    expect(projection.writeEffectsInTx).toHaveBeenCalledWith(
      tx,
      4,
      7,
      'ACCEPTED',
      'INVITATION',
      false,
    );
  });

  it('locks a remote-group peer allocator before the account feed', async () => {
    const requestedAt = new Date('2026-09-04T00:00:00.000Z');
    const order: string[] = [];
    const tx = {
      select: vi
        .fn()
        .mockImplementationOnce(() => queryResult([{ groupId: 9 }]))
        .mockImplementationOnce(() => queryResult([{ groupId: 9 }]))
        .mockImplementation(() =>
          queryResult([
            {
              id: 9,
              account: '!remote-group',
              domain: 'peer.example',
              namespaceId: 12,
              name: 'Remote group',
              avatar: '',
              description: '',
              profileRev: 4,
            },
          ]),
        ),
      query: {
        account: {
          findFirst: vi.fn().mockResolvedValue({
            account: 'local-user',
            domain: 'local',
            namespaceId: 0,
          }),
        },
      },
    } as never;
    const relationshipIntents = {
      lockGroupMutationInTx: vi.fn().mockResolvedValue({
        id: 1n,
        threadLock: {},
      }),
    };
    const stateFeed = {
      lockOutboundStateFeedNamespacesInTx: vi
        .fn()
        .mockImplementation(async () => {
          order.push('peer-lock');
        }),
      writeManyInTx: vi.fn().mockImplementation(async () => {
        order.push('peer-write');
        return new Map([['peer.example', 22n]]);
      }),
    };
    const clientStateFeed = {
      writeInTx: vi.fn().mockImplementation(async () => {
        order.push('client');
        return 21;
      }),
    };
    const groupRelationships = {
      writeLockedAuthoredIntentInTx: vi.fn().mockResolvedValue({
        request: {
          status: 'REVOKED',
          profileRev: 7,
          note: '',
          requestedAt,
          expiresAt: null,
        },
        changed: true,
        shouldBeActive: false,
        active: false,
        pairChanged: false,
        canonicalRosterChanged: false,
        audienceChanged: false,
        threadFanoutAdmitted: false,
      }),
    };
    const service = new GroupRelationshipMutationService(
      relationshipIntents as never,
      {} as never,
      {} as never,
      stateFeed as never,
      clientStateFeed as never,
      groupRelationships as never,
    );
    const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];

    await expect(
      service.writeMemberRelationshipIntentInTx(
        tx,
        4,
        7,
        'REVOKED',
        clientFeedUpdates,
      ),
    ).resolves.toEqual(new Map([['peer.example', 22n]]));

    expect(stateFeed.lockOutboundStateFeedNamespacesInTx).toHaveBeenCalledWith(
      tx,
      [{ namespaceId: 12 }],
    );
    expect(order).toEqual(['peer-lock', 'client', 'peer-write']);
    expect(clientStateFeed.writeInTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        userId: 7,
        account: 'local-user',
        subjectAccount: '!remote-group',
        body: expect.objectContaining({
          status: 'REVOKED',
          requestedAt: null,
          expiresAt: null,
        }),
      }),
    );
    expect(clientFeedUpdates).toEqual([{ userId: 7, feedId: 21 }]);
  });

  it('reopens a dissolved mirror after a successfully authored positive intent', async () => {
    const requestedAt = new Date('2026-09-14T00:00:00.000Z');
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    const tx = {
      select: vi
        .fn()
        .mockImplementationOnce(() => queryResult([{ groupId: 9 }]))
        .mockImplementation(() =>
          queryResult([
            {
              id: 9,
              account: '!remote-group',
              domain: 'peer.example',
              namespaceId: 12,
              name: 'Remote group',
              avatar: '',
              description: '',
              profileRev: 4,
            },
          ]),
        ),
      query: {
        account: {
          findFirst: vi.fn().mockResolvedValue({
            account: 'local-user',
            domain: 'local',
            namespaceId: 0,
          }),
        },
      },
      update: vi.fn(() => ({ set })),
    } as never;
    const relationshipIntents = {
      lockGroupMutationInTx: vi.fn(),
    };
    const stateFeed = {
      lockOutboundStateFeedNamespacesInTx: vi.fn(),
      writeManyInTx: vi.fn().mockResolvedValue(new Map()),
    };
    const groupRelationships = {
      writeLockedAuthoredIntentInTx: vi.fn().mockResolvedValue({
        request: {
          status: 'REQUESTED',
          profileRev: 8,
          note: 'join',
          requestedAt,
          expiresAt: new Date('2026-09-21T00:00:00.000Z'),
        },
        changed: true,
        shouldBeActive: false,
        active: false,
        pairChanged: true,
        canonicalRosterChanged: false,
        audienceChanged: false,
        threadFanoutAdmitted: false,
      }),
    };
    const service = new GroupRelationshipMutationService(
      relationshipIntents as never,
      {} as never,
      {} as never,
      stateFeed as never,
      { writeInTx: vi.fn().mockResolvedValue(null) } as never,
      groupRelationships as never,
    );

    await service.writeMemberRelationshipIntentInTx(
      tx,
      4,
      7,
      'REQUESTED',
      [],
      'join',
      undefined,
      {
        allowDissolvedPositive: true,
        lockedGroupPair: { pairId: 1n, threadLock: {} as never },
        validatedPairActive: false,
      },
    );

    expect(set).toHaveBeenCalledWith({
      groupDissolvedAt: null,
      federationRoundsEnabled: true,
      updatedAt: expect.any(Date),
    });
    expect(where).toHaveBeenCalled();
    expect(relationshipIntents.lockGroupMutationInTx).not.toHaveBeenCalled();
  });

  it('stops a member-authored denial revoke when the locked epoch changed', async () => {
    const tx = {
      select: vi
        .fn()
        .mockImplementationOnce(() => queryResult([{ groupId: 9 }]))
        .mockImplementationOnce(() =>
          queryResult([{ groupId: 9, authorizationEpoch: 10 }]),
        )
        .mockImplementationOnce(() =>
          queryResult([
            {
              id: 9,
              account: '!group',
              domain: 'peer.test',
              namespaceId: 5,
            },
          ]),
        ),
      query: {
        account: {
          findFirst: vi.fn().mockResolvedValue({
            account: 'member',
            domain: 'local',
            namespaceId: 0,
          }),
        },
      },
    } as never;
    const groupRelationships = { writeLockedAuthoredIntentInTx: vi.fn() };
    const service = new GroupRelationshipMutationService(
      {
        lockGroupMutationInTx: vi.fn().mockResolvedValue({
          id: 1n,
          threadLock: {},
        }),
      } as never,
      {} as never,
      {} as never,
      { lockOutboundStateFeedNamespacesInTx: vi.fn() } as never,
      {} as never,
      groupRelationships as never,
    );

    await expect(
      service.writeMemberRelationshipIntentInTx(
        tx,
        4,
        7,
        'REVOKED',
        [],
        '',
        undefined,
        {
          expectedAuthorization: {
            epoch: 9,
            group: {
              account: '!group',
              domain: 'peer.test',
              namespaceId: 5,
            },
          },
        },
      ),
    ).resolves.toEqual(new Map());
    expect(
      groupRelationships.writeLockedAuthoredIntentInTx,
    ).not.toHaveBeenCalled();
  });

  it('stops a group-authored denial revoke when the locked epoch changed', async () => {
    const tx = {
      select: vi
        .fn()
        .mockImplementationOnce(() => queryResult([{ groupId: 9 }]))
        .mockImplementationOnce(() =>
          queryResult([
            {
              groupId: 9,
              groupAccount: '!group',
              groupDomain: 'local',
              groupNamespaceId: 0,
              authorizationEpoch: 10,
            },
          ]),
        ),
    } as never;
    const groupRelationships = { writeLockedAuthoredIntentInTx: vi.fn() };
    const service = new GroupRelationshipMutationService(
      {
        lockGroupMutationInTx: vi.fn().mockResolvedValue({
          id: 1n,
          threadLock: {},
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      groupRelationships as never,
    );

    await expect(
      service.writeGroupRelationshipIntentInTx(
        tx,
        4,
        { account: 'remote', namespaceId: 5 },
        '',
        'REVOKED',
        [],
        undefined,
        {
          expectedAuthorization: {
            epoch: 9,
            group: { account: '!group', domain: 'local', namespaceId: 0 },
          },
        },
      ),
    ).resolves.toEqual(new Map());
    expect(
      groupRelationships.writeLockedAuthoredIntentInTx,
    ).not.toHaveBeenCalled();
  });
});
