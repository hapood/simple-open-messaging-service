import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federatedPeer,
  groupMembershipRequest,
  peerStateFeed,
  peerStateFeedTarget,
  user,
} from '../src/database/schema.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import { GroupMembershipStateService } from '../src/group/group-membership-state.service.js';

const DOMAINS = ['state-feed-a.test', 'state-feed-b.test'];

describe('per-peer state feed', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let feed: PeerStateFeedService;
  let membership: GroupMembershipStateService;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [PeerStateFeedService, GroupMembershipStateService],
    }).compile();
    database = mod.get(DatabaseService);
    feed = mod.get(PeerStateFeedService);
    membership = mod.get(GroupMembershipStateService);
    await database.db
      .insert(federatedPeer)
      .values(DOMAINS.map((domain) => ({ domain, trustLevel: 'trusted' })))
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await database.db
      .delete(federatedPeer)
      .where(eq(federatedPeer.domain, DOMAINS[0]));
    await database.db
      .delete(federatedPeer)
      .where(eq(federatedPeer.domain, DOMAINS[1]));
    await mod.close();
  });

  it('compacts a key, ignores stale revisions, and does not allocate a rev for no-op writes', async () => {
    await database.db.transaction(async (tx) => {
      await feed.writeManyInTx(tx, [
        {
          peerDomain: DOMAINS[0],
          account: 'alice',
          eventType: 'PROFILE',
          revision: 1,
          body: { name: 'A' },
        },
      ]);
      await feed.writeManyInTx(tx, [
        {
          peerDomain: DOMAINS[0],
          account: 'alice',
          eventType: 'PROFILE',
          revision: 2,
          body: { name: 'B' },
        },
      ]);
      await feed.writeManyInTx(tx, [
        {
          peerDomain: DOMAINS[0],
          account: 'alice',
          eventType: 'PROFILE',
          revision: 1,
          body: { name: 'stale' },
        },
      ]);
    });
    const page = await feed.serve(DOMAINS[0], 0n);
    expect(page.stateFeedRev).toBe('2');
    expect(page.scannedThrough).toBe('2');
    expect(page.items).toMatchObject([
      { revision: '2', rev: '2', body: { name: 'B' } },
    ]);
  });

  it('keeps multiple P2P subjects and peers independent', async () => {
    await database.db.transaction(async (tx) => {
      await feed.writeManyInTx(tx, [
        {
          peerDomain: DOMAINS[0],
          account: 'alice',
          subjectAccount: 'bob',
          eventType: 'P2P_META',
          revision: 1,
          body: { recognizesFriend: true },
        },
        {
          peerDomain: DOMAINS[0],
          account: 'alice',
          subjectAccount: 'carol',
          eventType: 'P2P_META',
          revision: 1,
          body: { recognizesFriend: false },
        },
        {
          peerDomain: DOMAINS[1],
          account: 'alice',
          eventType: 'PROFILE',
          revision: 1,
          body: { name: 'private-to-b' },
        },
      ]);
    });
    const a = await feed.serve(DOMAINS[0], 2n);
    const b = await feed.serve(DOMAINS[1], 0n);
    expect(a.items.map((x) => x.subjectAccount)).toEqual(['bob', 'carol']);
    expect(b.items).toHaveLength(1);
    expect(b.items[0].body).toMatchObject({ name: 'private-to-b' });
  });

  it('rejects a cursor rollback after the peer acknowledges a later page', async () => {
    await feed.serve(DOMAINS[0], 4n);
    await expect(feed.serve(DOMAINS[0], 0n)).rejects.toMatchObject({
      bizCode: expect.anything(),
      status: 409,
    });
  });

  it('rolls allocation and item back atomically', async () => {
    await expect(
      database.db.transaction(async (tx) => {
        await feed.writeManyInTx(tx, [
          {
            peerDomain: DOMAINS[1],
            account: 'rollback',
            eventType: 'PROFILE',
            revision: 1,
            body: {},
          },
        ]);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const [target] = await database.db
      .select()
      .from(peerStateFeedTarget)
      .where(eq(peerStateFeedTarget.peerDomain, DOMAINS[1]));
    const rows = await database.db
      .select()
      .from(peerStateFeed)
      .where(eq(peerStateFeed.account, 'rollback'));
    expect(target.allocatedThrough).toBe(1n);
    expect(rows).toHaveLength(0);
  });

  it('cascades feed, allocator, and pull cursor on peer deletion', async () => {
    const domain = 'state-feed-cascade.test';
    await database.db.insert(federatedPeer).values({ domain });
    await database.db.transaction((tx) =>
      feed.writeManyInTx(tx, [
        {
          peerDomain: domain,
          account: 'alice',
          eventType: 'PROFILE',
          revision: 1,
          body: {},
        },
      ]),
    );
    await database.db
      .delete(federatedPeer)
      .where(eq(federatedPeer.domain, domain));
    expect(await feed.readRev(domain)).toBe(0n);
  });

  it('does not touch a received group direction when its revision is unchanged', async () => {
    const suffix = Date.now().toString(36);
    const [groupUser, memberUser] = await database.db
      .insert(user)
      .values([
        {
          account: `!rev-${suffix}`,
          name: 'revision group',
          isForeigner: true,
          isGroup: true,
          domain: DOMAINS[0],
          updatedAt: new Date(),
        },
        {
          account: `rev-${suffix}`,
          name: 'revision member',
          isForeigner: false,
          updatedAt: new Date(),
        },
      ])
      .returning({ id: user.id });

    try {
      await database.db.transaction((tx) =>
        membership.applyRemoteDirectionInTx(tx, {
          groupUserId: groupUser.id,
          memberUserId: memberUser.id,
          direction: 'INVITE',
          status: 'REQUESTED',
          note: 'first',
          revision: 7,
          requestedAt: new Date('2026-01-01T00:00:00Z'),
          expiresAt: null,
        }),
      );
      const before = await database.db.query.groupMembershipRequest.findFirst({
        where: and(
          eq(groupMembershipRequest.groupUserId, groupUser.id),
          eq(groupMembershipRequest.memberUserId, memberUser.id),
          eq(groupMembershipRequest.direction, 'INVITE'),
        ),
      });

      const replay = await database.db.transaction((tx) =>
        membership.applyRemoteDirectionInTx(tx, {
          groupUserId: groupUser.id,
          memberUserId: memberUser.id,
          direction: 'INVITE',
          status: 'NOT_MEMBER',
          note: 'must not overwrite',
          revision: 7,
          requestedAt: null,
          expiresAt: null,
        }),
      );
      const after = await database.db.query.groupMembershipRequest.findFirst({
        where: and(
          eq(groupMembershipRequest.groupUserId, groupUser.id),
          eq(groupMembershipRequest.memberUserId, memberUser.id),
          eq(groupMembershipRequest.direction, 'INVITE'),
        ),
      });

      expect(replay.changed).toBe(false);
      expect(after).toEqual(before);
    } finally {
      await database.db
        .delete(user)
        .where(inArray(user.id, [groupUser.id, memberUser.id]));
    }
  });
});
