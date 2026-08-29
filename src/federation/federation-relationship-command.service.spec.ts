import { describe, expect, it, vi } from 'vitest';
import { FederationRelationshipCommandService } from './federation-relationship-command.service.js';

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

describe('FederationRelationshipCommandService', () => {
  it('passes the caller transaction through the group command lock', async () => {
    const tx = {
      select: vi.fn(() => queryResult([{ groupId: 9 }])),
    } as never;
    const relationshipIntents = {
      lockGroupMutationInTx: vi.fn().mockResolvedValue(undefined),
    };
    const service = new FederationRelationshipCommandService(
      relationshipIntents as never,
      {} as never,
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
    const service = new FederationRelationshipCommandService(
      {} as never,
      projection as never,
      {} as never,
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
      readP2PRelationshipInTx: vi.fn().mockResolvedValue({
        firstIntent: {
          status: 'REQUESTED',
          note: 'hello',
          requestedAt,
          expiresAt,
        },
      }),
    };
    const invite = {
      writeLocalFriendIntentInTx: vi
        .fn()
        .mockResolvedValue([{ userId: 1, feedId: 2 }]),
    };
    const stateFeed = {
      writeManyInTx: vi.fn().mockResolvedValue(new Map([['peer.example', 3n]])),
    };
    const profiles = {
      writeUserProfileToPeerInTx: vi
        .fn()
        .mockResolvedValue(new Map([['peer.example', 4n]])),
    };
    const service = new FederationRelationshipCommandService(
      relationshipIntents as never,
      {} as never,
      invite as never,
      stateFeed as never,
      profiles as never,
      {} as never,
      {} as never,
    );
    const clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];

    const result = await service.writeFriendIntentInTx(
      tx,
      1,
      2,
      true,
      'hello',
      clientFeedUpdates,
    );

    expect(invite.writeLocalFriendIntentInTx).toHaveBeenCalledWith(
      tx,
      1,
      2,
      true,
      'hello',
    );
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
        }),
      ]),
    );
    expect(profiles.writeUserProfileToPeerInTx).toHaveBeenCalledWith(
      tx,
      1,
      'peer.example',
      12,
      true,
    );
    expect(stateFeed.writeManyInTx.mock.invocationCallOrder[0]).toBeLessThan(
      profiles.writeUserProfileToPeerInTx.mock.invocationCallOrder[0],
    );
    expect(clientFeedUpdates).toEqual([{ userId: 1, feedId: 2 }]);
    expect(result).toEqual(new Map([['peer.example', 4n]]));
  });
});
