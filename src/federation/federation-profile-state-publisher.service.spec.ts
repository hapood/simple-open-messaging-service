import { describe, expect, it, vi } from 'vitest';
import { FederationProfileStatePublisher } from './federation-profile-state-publisher.service.js';

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

describe('FederationProfileStatePublisher', () => {
  it('commits group-meta heads before publishing their state-feed references', async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(() =>
        queryResult([
          {
            groupId: 9,
            account: '!group',
            name: 'Group',
            bio: '',
            avatar: '',
            profileRev: 3,
            dissolvedAt: null,
          },
        ]),
      )
      .mockImplementationOnce(() =>
        queryResult([
          {
            account: 'alice',
            domain: 'local',
            namespaceId: 0,
            role: 'OWNER',
            name: 'Alice',
            avatar: '',
            profileRev: 2,
            left: false,
          },
        ]),
      )
      .mockImplementationOnce(() =>
        queryResult([{ domain: 'peer.test', namespaceId: 12 }]),
      );
    const tx = { select } as never;
    const stateFeed = {
      writeManyInTx: vi.fn().mockResolvedValue(new Map([['peer.test', 11n]])),
    };
    const clientStateFeed = {
      recordGroupStateInTx: vi.fn().mockResolvedValue([]),
    };
    const groupMetaFeed = {
      reconcileInTx: vi.fn().mockResolvedValue(10n),
    };
    const threadContentHeads = {
      refreshInTx: vi.fn().mockResolvedValue(undefined),
    };
    const publisher = new FederationProfileStatePublisher(
      stateFeed as never,
      clientStateFeed as never,
      threadContentHeads as never,
      groupMetaFeed as never,
    );

    await publisher.writeGroupStateInTx(tx, 5, []);

    expect(groupMetaFeed.reconcileInTx).toHaveBeenCalledWith(
      tx,
      'peer.test',
      12,
      9,
      3,
      [
        expect.objectContaining({
          account: 'alice',
          body: { role: 'OWNER' },
        }),
      ],
    );
    expect(
      groupMetaFeed.reconcileInTx.mock.invocationCallOrder[0],
    ).toBeLessThan(stateFeed.writeManyInTx.mock.invocationCallOrder[0]);
    expect(stateFeed.writeManyInTx).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        eventType: 'GROUP_META_FEED_HEAD',
        body: { groupMetaFeedEndId: '10' },
      }),
    ]);
    expect(threadContentHeads.refreshInTx).toHaveBeenCalledWith(
      tx,
      'peer.test',
      12,
      5,
    );
    expect(stateFeed.writeManyInTx.mock.invocationCallOrder[0]).toBeLessThan(
      threadContentHeads.refreshInTx.mock.invocationCallOrder[0],
    );
  });
});
