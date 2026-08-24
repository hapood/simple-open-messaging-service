import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federatedFriendRequest,
  federatedPeer,
  federatedProfile,
  relationshipIntent,
  peerStateFeed,
  peerStateFeedTarget,
  user,
} from '../src/database/schema.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import { RelationshipIntentService } from '../src/invite/relationship-intent.service.js';
import { FederationService } from '../src/federation/federation.service.js';
import type { DatabaseTransaction } from '../src/database/database.service.js';

const DOMAINS = ['state-feed-a.test', 'state-feed-b.test'];

describe('per-peer state feed', () => {
  const wireTime = new Date('2026-08-09T00:00:00.123Z');
  let mod: TestingModule;
  let database: DatabaseService;
  let feed: PeerStateFeedService;
  let membership: RelationshipIntentService;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [PeerStateFeedService, RelationshipIntentService],
    }).compile();
    database = mod.get(DatabaseService);
    feed = mod.get(PeerStateFeedService);
    membership = mod.get(RelationshipIntentService);
    await database.db
      .insert(federatedPeer)
      .values(DOMAINS.map((domain) => ({ domain, trustLevel: 'available' })))
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

  it('compacts a key and does not allocate a feed ID for identical writes', async () => {
    await database.db.transaction(async (tx) => {
      await feed.writeManyInTx(tx, [
        {
          peerDomain: DOMAINS[0],
          account: 'alice',
          domain: 'local.test',
          eventType: 'PROFILE',
          body: { name: 'A' },
        },
      ]);
      await feed.writeManyInTx(tx, [
        {
          peerDomain: DOMAINS[0],
          account: 'alice',
          domain: 'local.test',
          eventType: 'PROFILE',
          body: { name: 'B', updatedAt: wireTime, opaqueRevision: 9n },
        },
      ]);
      await feed.writeManyInTx(tx, [
        {
          peerDomain: DOMAINS[0],
          account: 'alice',
          domain: 'local.test',
          eventType: 'PROFILE',
          body: { name: 'B', updatedAt: wireTime, opaqueRevision: 9n },
        },
      ]);
    });
    const page = await feed.serve(DOMAINS[0], 0n);
    expect(page.stateFeedEndId).toBe('2');
    expect(page.scannedThrough).toBe('2');
    expect(page.items).toMatchObject([
      {
        feedId: '2',
        body: {
          name: 'B',
          updatedAt: wireTime.getTime(),
          opaqueRevision: '9',
        },
      },
    ]);
  });

  it('does not persist an unsolicited human PROFILE without a preceding request', async () => {
    const account = 'unsolicited-profile';
    const peerDomain = DOMAINS[0];
    const receiver = Object.create(
      FederationService.prototype,
    ) as FederationService;
    Object.assign(receiver, {
      config: { domain: 'receiver.test' },
    });
    const applyStateFeedPageInTx = receiver['applyStateFeedPageInTx'].bind(
      receiver,
    ) as (
      tx: DatabaseTransaction,
      domain: string,
      page: {
        stateFeedEndId: string;
        scannedThrough: string;
        hasMore: boolean;
        items: Array<{
          account: string;
          domain: string;
          eventType: 'PROFILE';
          feedId: string;
          body: {
            profileRev: number;
            displayName: string;
            bio: string;
            avatar: null;
          };
        }>;
      },
    ) => Promise<unknown>;

    await database.db.transaction((tx) =>
      applyStateFeedPageInTx(tx, peerDomain, {
        stateFeedEndId: '1',
        scannedThrough: '1',
        hasMore: false,
        items: [
          {
            account,
            domain: peerDomain,
            eventType: 'PROFILE',
            feedId: '1',
            body: {
              profileRev: 1,
              displayName: 'Unsolicited Profile',
              bio: '',
              avatar: null,
            },
          },
        ],
      }),
    );

    expect(
      await database.db.query.federatedProfile.findFirst({
        where: and(
          eq(federatedProfile.domain, peerDomain),
          eq(federatedProfile.account, account),
        ),
      }),
    ).toBeUndefined();
    expect(
      await database.db.query.federatedFriendRequest.findFirst({
        where: and(
          eq(federatedFriendRequest.remoteDomain, peerDomain),
          eq(federatedFriendRequest.remoteAccount, account),
        ),
      }),
    ).toBeUndefined();
    expect(
      await database.db.query.user.findFirst({
        where: and(eq(user.domain, peerDomain), eq(user.account, account)),
      }),
    ).toBeUndefined();
  });

  it('reindexes an unchanged confirmation when explicitly required', async () => {
    const domain = 'state-feed-confirmation.test';
    await database.db.insert(federatedPeer).values({ domain });
    try {
      const body = {
        status: 'ACCEPTED',
        note: '',
        requestedAt: wireTime,
        expiresAt: null,
      };
      await database.db.transaction(async (tx) => {
        await feed.writeManyInTx(tx, [
          {
            peerDomain: domain,
            account: 'alice',
            domain: 'local.test',
            subjectAccount: 'bob',
            subjectDomain: domain,
            eventType: 'RELATIONSHIP_INTENT',
            body,
          },
        ]);
        await feed.writeManyInTx(tx, [
          {
            peerDomain: domain,
            account: 'alice',
            domain: 'local.test',
            subjectAccount: 'bob',
            subjectDomain: domain,
            eventType: 'RELATIONSHIP_INTENT',
            body,
            forceReindex: true,
          },
        ]);
      });

      const page = await feed.serve(domain, 0n);
      expect(page.stateFeedEndId).toBe('2');
      expect(page.items).toEqual([
        {
          account: 'alice',
          domain: 'local.test',
          eventType: 'RELATIONSHIP_INTENT',
          localAccount: 'bob',
          feedId: '2',
          body: {
            status: 'ACCEPTED',
            note: '',
            requestedAt: wireTime.getTime(),
            expiresAt: null,
          },
        },
      ]);
    } finally {
      await database.db
        .delete(federatedPeer)
        .where(eq(federatedPeer.domain, domain));
    }
  });

  it('advances the feed while reusing the current snapshot revision', async () => {
    const domain = 'state-feed-snapshot-revision.test';
    await database.db.insert(federatedPeer).values({ domain });
    try {
      const write = {
        peerDomain: domain,
        account: 'alice',
        domain: 'local.test',
        eventType: 'PROFILE' as const,
        body: { profileRev: 7, displayName: 'Alice', bio: '', avatar: null },
      };
      await database.db.transaction(async (tx) => {
        await feed.writeManyInTx(tx, [write]);
        await feed.writeManyInTx(tx, [{ ...write, forceReindex: true }]);
      });

      const page = await feed.serve(domain, 0n);
      expect(page.stateFeedEndId).toBe('2');
      expect(page.items).toMatchObject([
        { feedId: '2', body: { profileRev: 7 } },
      ]);
    } finally {
      await database.db
        .delete(federatedPeer)
        .where(eq(federatedPeer.domain, domain));
    }
  });

  it('deduplicates an unchanged snapshot revision without reindexing', async () => {
    const domain = 'state-feed-snapshot-dedup.test';
    await database.db.insert(federatedPeer).values({ domain });
    try {
      const write = {
        peerDomain: domain,
        account: 'alice',
        domain: 'local.test',
        eventType: 'PROFILE' as const,
        body: { profileRev: 8, displayName: 'Alice', bio: '', avatar: null },
      };
      await database.db.transaction(async (tx) => {
        await feed.writeManyInTx(tx, [write]);
        await feed.writeManyInTx(tx, [write]);
      });

      const page = await feed.serve(domain, 0n);
      expect(page.stateFeedEndId).toBe('1');
      expect(page.items).toMatchObject([
        { feedId: '1', body: { profileRev: 8 } },
      ]);
    } finally {
      await database.db
        .delete(federatedPeer)
        .where(eq(federatedPeer.domain, domain));
    }
  });

  it('rejects PROFILE changes that do not advance the snapshot revision', async () => {
    const domain = 'state-feed-snapshot-mutation.test';
    await database.db.insert(federatedPeer).values({ domain });
    try {
      await expect(
        database.db.transaction(async (tx) => {
          await feed.writeManyInTx(tx, [
            {
              peerDomain: domain,
              account: 'alice',
              domain: 'local.test',
              eventType: 'PROFILE',
              body: {
                profileRev: 9,
                displayName: 'Alice',
                bio: '',
                avatar: null,
              },
            },
          ]);
          await feed.writeManyInTx(tx, [
            {
              peerDomain: domain,
              account: 'alice',
              domain: 'local.test',
              eventType: 'PROFILE',
              forceReindex: true,
              body: {
                profileRev: 9,
                displayName: 'Changed without revision',
                bio: '',
                avatar: null,
              },
            },
          ]);
        }),
      ).rejects.toThrow('PROFILE revision 9 changed without advancing');

      expect(
        await database.db.query.peerStateFeedTarget.findFirst({
          where: eq(peerStateFeedTarget.peerDomain, domain),
        }),
      ).toBeUndefined();
      expect(
        await database.db.query.peerStateFeed.findFirst({
          where: eq(peerStateFeed.peerDomain, domain),
        }),
      ).toBeUndefined();
    } finally {
      await database.db
        .delete(federatedPeer)
        .where(eq(federatedPeer.domain, domain));
    }
  });

  it('keeps multiple P2P subjects and peers independent', async () => {
    await database.db.transaction(async (tx) => {
      await feed.writeManyInTx(tx, [
        {
          peerDomain: DOMAINS[0],
          account: 'alice',
          domain: 'local.test',
          subjectAccount: 'bob',
          subjectDomain: DOMAINS[0],
          eventType: 'RELATIONSHIP_INTENT',
          body: {
            status: 'ACCEPTED',
            note: '',
            requestedAt: wireTime,
            expiresAt: null,
          },
        },
        {
          peerDomain: DOMAINS[0],
          account: 'alice',
          domain: 'local.test',
          subjectAccount: 'carol',
          subjectDomain: DOMAINS[0],
          eventType: 'RELATIONSHIP_INTENT',
          body: {
            status: 'REVOKED',
            note: '',
            requestedAt: null,
            expiresAt: null,
          },
        },
        {
          peerDomain: DOMAINS[1],
          account: 'alice',
          domain: 'local.test',
          eventType: 'PROFILE',
          body: { name: 'private-to-b' },
        },
      ]);
    });
    const a = await feed.serve(DOMAINS[0], 2n);
    const b = await feed.serve(DOMAINS[1], 0n);
    expect(a.items.map((x) => x.localAccount)).toEqual(['bob', 'carol']);
    expect(b.items).toHaveLength(1);
    expect(b.items[0].body).toMatchObject({ name: 'private-to-b' });
  });

  it('serves an older after without maintaining a source-side peer cursor', async () => {
    const later = await feed.serve(DOMAINS[0], 4n);
    const replay = await feed.serve(DOMAINS[0], 0n);
    expect(BigInt(replay.scannedThrough)).toBeGreaterThanOrEqual(
      BigInt(later.scannedThrough),
    );
    expect(replay.items.length).toBeGreaterThan(0);
  });

  it('rolls allocation and item back atomically', async () => {
    await expect(
      database.db.transaction(async (tx) => {
        await feed.writeManyInTx(tx, [
          {
            peerDomain: DOMAINS[1],
            account: 'rollback',
            domain: 'local.test',
            eventType: 'PROFILE',
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
          domain: 'local.test',
          eventType: 'PROFILE',
          body: {},
        },
      ]),
    );
    await database.db
      .delete(federatedPeer)
      .where(eq(federatedPeer.domain, domain));
    expect(await feed.readRev(domain)).toBe(0n);
  });

  it('applies a later received group direction snapshot', async () => {
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
        membership.applyRemoteIntentInTx(tx, {
          groupUserId: groupUser.id,
          memberUserId: memberUser.id,
          authorUserId: groupUser.id,
          status: 'REQUESTED',
          note: 'first',
          requestedAt: new Date('2026-01-01T00:00:00Z'),
          expiresAt: new Date('2026-01-08T00:00:00Z'),
        }),
      );
      const before = await database.db.query.relationshipIntent.findFirst({
        where: and(
          eq(relationshipIntent.authorUserId, groupUser.id),
          eq(relationshipIntent.subjectUserId, memberUser.id),
        ),
      });

      const replay = await database.db.transaction((tx) =>
        membership.applyRemoteIntentInTx(tx, {
          groupUserId: groupUser.id,
          memberUserId: memberUser.id,
          authorUserId: groupUser.id,
          status: 'REVOKED',
          note: 'must not overwrite',
          requestedAt: null,
          expiresAt: null,
        }),
      );
      const after = await database.db.query.relationshipIntent.findFirst({
        where: and(
          eq(relationshipIntent.authorUserId, groupUser.id),
          eq(relationshipIntent.subjectUserId, memberUser.id),
        ),
      });

      expect(replay.changed).toBe(true);
      expect(after).not.toEqual(before);
      expect(after?.status).toBe('REVOKED');
    } finally {
      await database.db
        .delete(user)
        .where(inArray(user.id, [groupUser.id, memberUser.id]));
    }
  });
});
