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
  it('publishes a directly addressed user profile', async () => {
    const tx = {
      select: vi.fn(() =>
        queryResult([
          {
            account: 'alice',
            name: 'Alice',
            avatar: 'avatars/alice.webp',
            bio: 'hello',
            profileRev: 4,
          },
        ]),
      ),
    } as never;
    const stateFeed = {
      writeManyInTx: vi.fn().mockResolvedValue(new Map([['peer.test', 7n]])),
    };
    const upload = {
      readAvatarAsWire: vi.fn().mockResolvedValue({
        b64: Buffer.from('avatar').toString('base64'),
        w: 32,
        h: 32,
      }),
    };
    const publisher = new FederationProfileStatePublisher(
      upload as never,
      stateFeed as never,
      {} as never,
      undefined,
    );

    await expect(
      publisher.writeUserProfileToPeerInTx(tx, 1, 'peer.test', true),
    ).resolves.toEqual(new Map([['peer.test', 7n]]));
    expect(stateFeed.writeManyInTx).toHaveBeenCalledWith(tx, [
      expect.objectContaining({
        peerDomain: 'peer.test',
        account: 'alice',
        eventType: 'PROFILE',
        forceReindex: true,
        body: expect.objectContaining({
          profileRev: 4,
          displayName: 'Alice',
          bio: 'hello',
          avatar: expect.objectContaining({ width: 32, height: 32 }),
        }),
      }),
    ]);
  });

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
            role: 'OWNER',
            name: 'Alice',
            avatar: '',
            profileRev: 2,
            left: false,
          },
        ]),
      )
      .mockImplementationOnce(() => queryResult([{ domain: 'peer.test' }]));
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
    const publisher = new FederationProfileStatePublisher(
      { readAvatarAsWire: vi.fn() } as never,
      stateFeed as never,
      clientStateFeed as never,
      groupMetaFeed as never,
    );

    await publisher.writeGroupStateInTx(tx, 5, []);

    expect(groupMetaFeed.reconcileInTx).toHaveBeenCalledWith(
      tx,
      'peer.test',
      9,
      [
        expect.objectContaining({
          account: 'alice',
          body: expect.objectContaining({ role: 'OWNER', profileRev: 2 }),
        }),
      ],
    );
    expect(
      groupMetaFeed.reconcileInTx.mock.invocationCallOrder[0],
    ).toBeLessThan(stateFeed.writeManyInTx.mock.invocationCallOrder[0]);
    expect(stateFeed.writeManyInTx).toHaveBeenCalledWith(tx, [
      expect.objectContaining({ eventType: 'PROFILE', account: '!group' }),
      expect.objectContaining({
        eventType: 'GROUP_META_FEED_HEAD',
        body: { groupMetaFeedEndId: '10' },
      }),
    ]);
  });
});
