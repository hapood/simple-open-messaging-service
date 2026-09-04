import { describe, expect, it, vi } from 'vitest';
import { FederationRelationshipMutationService } from './federation-relationship-mutation.service.js';

process.env.SOMS_DOMAIN ??= 'chat.example';

function queryResult<T>(value: T) {
  const query: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'limit'])
    query[method] = vi.fn(() => query);
  query.then = (
    resolve: (result: T) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return query;
}

describe('FederationRelationshipMutationService', () => {
  it('passes the caller transaction through the group command lock', async () => {
    const tx = {
      select: vi.fn(() => queryResult([{ groupId: 9 }])),
    } as never;
    const relationshipIntents = {
      lockGroupMutationInTx: vi.fn().mockResolvedValue(undefined),
    };
    const service = new FederationRelationshipMutationService(
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
    const service = new FederationRelationshipMutationService(
      {} as never,
      projection as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const updates: Array<{ userId: number; feedId: number }> = [];

    await service.writeGroupRequestEffectsInTx(
      tx,
      4,
      9,
      7,
      updates,
      'ACCEPTED',
      'INVITATION',
      false,
      8,
    );

    expect(projection.writeEffectsInTx).toHaveBeenCalledWith(
      tx,
      4,
      9,
      7,
      updates,
      'ACCEPTED',
      'INVITATION',
      false,
      8,
    );
  });

  it('writes a friend intent and its peer projections in the caller transaction', async () => {
    const requestedAt = new Date('2026-08-28T00:00:00.000Z');
    const expiresAt = new Date('2026-09-04T00:00:00.000Z');
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({
        account: 'remote-user',
        domain: 'peer.example',
        namespaceId: 12,
      })
      .mockResolvedValueOnce({ account: 'local-user' });
    const tx = { query: { user: { findFirst } } } as never;
    const relationshipIntents = {
      lockPairInTx: vi.fn().mockResolvedValue({}),
      readP2PRelationshipInTx: vi.fn().mockResolvedValue({
        firstIntent: {
          status: 'REQUESTED',
          profileRev: 4,
          note: 'hello',
          requestedAt,
          expiresAt,
        },
      }),
    };
    const order: string[] = [];
    const relationships = {
      writeLocalP2PIntentInTx: vi.fn().mockImplementation(async () => {
        order.push('client');
        return [{ userId: 1, feedId: 2 }];
      }),
    };
    const stateFeed = {
      lockTargetsInTx: vi.fn().mockImplementation(async () => {
        order.push('peer-lock');
      }),
      writeManyInTx: vi.fn().mockImplementation(async () => {
        order.push('peer-write');
        return new Map([['peer.example', 3n]]);
      }),
    };
    const service = new FederationRelationshipMutationService(
      relationshipIntents as never,
      {} as never,
      relationships as never,
      stateFeed as never,
      {} as never,
      {} as never,
    );
    const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];

    const result = await service.writeP2PIntentInTx(
      tx,
      1,
      2,
      true,
      'hello',
      clientFeedUpdates,
    );

    expect(relationships.writeLocalP2PIntentInTx).toHaveBeenCalledWith(
      tx,
      1,
      2,
      true,
      'hello',
    );
    expect(stateFeed.lockTargetsInTx).toHaveBeenCalledWith(tx, [
      { peerDomain: 'peer.example', namespaceId: 12 },
    ]);
    expect(relationshipIntents.readP2PRelationshipInTx).toHaveBeenCalledWith(
      tx,
      1,
      2,
    );
    expect(stateFeed.writeManyInTx).toHaveBeenCalledWith(
      tx,
      expect.arrayContaining([
        expect.objectContaining({
          peerDomain: 'peer.example',
          account: 'local-user',
          subjectAccount: 'remote-user',
          eventType: 'RELATIONSHIP_INTENT',
          body: expect.objectContaining({ profileRev: 4 }),
        }),
      ]),
    );
    expect(clientFeedUpdates).toEqual([{ userId: 1, feedId: 2 }]);
    expect(result).toEqual(new Map([['peer.example', 3n]]));
    expect(order).toEqual(['peer-lock', 'client', 'peer-write']);
  });

  it('locks a remote-group peer allocator before the account feed', async () => {
    const requestedAt = new Date('2026-09-04T00:00:00.000Z');
    const order: string[] = [];
    const tx = {
      select: vi.fn(() => queryResult([{ groupId: 9 }])),
      query: {
        group: {
          findFirst: vi.fn().mockResolvedValue({
            account: '!remote-group',
            domain: 'peer.example',
            namespaceId: 12,
            name: 'Remote group',
            avatar: '',
            description: '',
            defaultProfileRev: 4,
          }),
        },
        user: {
          findFirst: vi.fn().mockResolvedValue({
            account: 'local-user',
            domain: 'local',
          }),
        },
      },
    } as never;
    const relationshipIntents = {
      lockGroupMutationInTx: vi.fn().mockResolvedValue(undefined),
    };
    const stateFeed = {
      lockTargetsInTx: vi.fn().mockImplementation(async () => {
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
      writeAuthoredIntentInTx: vi.fn().mockResolvedValue({
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
        fanoutTaskCreated: false,
      }),
    };
    const service = new FederationRelationshipMutationService(
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

    expect(stateFeed.lockTargetsInTx).toHaveBeenCalledWith(tx, [
      { peerDomain: 'peer.example', namespaceId: 12 },
    ]);
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

  it('locks both account addresses before materializing a first-contact peer', async () => {
    const order: string[] = [];
    const tx = {
      execute: vi.fn().mockImplementation(async () => {
        order.push('account-lock');
        return { rows: [] };
      }),
      query: {
        user: {
          findFirst: vi.fn().mockResolvedValue({ account: 'local-user' }),
        },
      },
    } as never;
    const relationshipIntents = {
      lockPairInTx: vi.fn().mockImplementation(async () => {
        order.push('pair-lock');
      }),
      readP2PRelationshipInTx: vi.fn().mockResolvedValue({
        firstIntent: {
          status: 'REQUESTED',
          profileRev: 3,
          note: '',
          requestedAt: new Date('2026-09-04T00:00:00.000Z'),
          expiresAt: new Date('2026-09-11T00:00:00.000Z'),
        },
      }),
    };
    const relationships = {
      writeLocalP2PIntentInTx: vi.fn().mockImplementation(async () => {
        order.push('client');
        return [];
      }),
    };
    const stateFeed = {
      lockTargetsInTx: vi.fn().mockImplementation(async () => {
        order.push('peer-lock');
      }),
      writeManyInTx: vi.fn().mockResolvedValue(new Map()),
    };
    const service = new FederationRelationshipMutationService(
      relationshipIntents as never,
      {} as never,
      relationships as never,
      stateFeed as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(
      service as unknown as {
        materializeFederatedUserInTx: () => Promise<number>;
      },
      'materializeFederatedUserInTx',
    ).mockImplementation(async () => {
      order.push('materialize');
      return 2;
    });

    await service.writeAddressedRelationshipRequestInTx(
      tx,
      1,
      { account: 'remote-user', domain: 'peer.example', namespaceId: 12 },
      {
        requestedAt: new Date('2026-09-04T00:00:00.000Z'),
        expiresAt: new Date('2026-09-11T00:00:00.000Z'),
        note: '',
        snapshot: { displayName: 'Remote user' },
      },
      [],
    );

    expect(order).toEqual([
      'account-lock',
      'account-lock',
      'materialize',
      'pair-lock',
      'peer-lock',
      'client',
    ]);
  });
});
