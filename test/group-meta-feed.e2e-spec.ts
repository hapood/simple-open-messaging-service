import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localIdentityDomain } from './support/local-domain.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  groupAccount as groupAccountTable,
  groupMeta,
  groupMetaMemberFeed,
  identityNamespace,
  messageThread,
  message,
  profileTable,
  relationshipIntent,
  relationshipPair,
  threadAudience,
  account as user,
} from '../src/database/schema.js';
import { GroupRole, MessageThreadType } from '../src/database/enums.js';
import { GroupMetaFeedService } from '../src/group/meta/group-meta-feed.service.js';
import { FederationGroupMetaFeedService } from '../src/federation/group-meta-feed.service.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { FederationProfileService } from '../src/federation/federation-profile.service.js';
import { readGroupMetaPageInTx } from '../src/group/meta/group-meta-page.js';
import { ClientGroupMetaFeedService } from '../src/client-state-feed/client-group-meta-feed.service.js';

describe('canonical Group Meta feed', () => {
  const suffix = Date.now().toString(36);
  const peerDomain = `group-meta-${suffix}.test`;
  const otherPeerDomain = `group-meta-other-${suffix}.test`;
  const groupAccount = `!groupmeta${suffix}`;
  const ownerAccount = `owner-${suffix}`;
  const memberAccount = `member-${suffix}`;
  const observerAccount = `observer-${suffix}`;
  let module: TestingModule;
  let database: DatabaseService;
  let feed: GroupMetaFeedService;
  let publisher: FederationGroupMetaFeedService;
  let clientFeed: ClientGroupMetaFeedService;
  let groupId: number;
  let threadId: number;
  let ownerUserId: number;
  let peerNamespaceId: number;
  let otherPeerNamespaceId: number;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        GroupMetaFeedService,
        FederationGroupMetaFeedService,
        ClientGroupMetaFeedService,
      ],
    }).compile();
    database = module.get(DatabaseService);
    feed = module.get(GroupMetaFeedService);
    publisher = module.get(FederationGroupMetaFeedService);
    clientFeed = module.get(ClientGroupMetaFeedService);
    peerNamespaceId = await seedFederatedPeerNamespace(database.db, peerDomain);
    otherPeerNamespaceId = await seedFederatedPeerNamespace(
      database.db,
      otherPeerDomain,
    );

    const [owner] = await database.db
      .insert(user)
      .values({ account: ownerAccount, defaultProfileRev: 1 })
      .returning();
    ownerUserId = owner.id;
    await database.db.insert(profileTable).values({
      account: ownerAccount,
      namespaceId: 0,
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      profileRev: 1,
      displayName: 'Owner',
    });
    const [control] = await database.db
      .insert(groupAccountTable)
      .values({ account: groupAccount, defaultProfileRev: 1 })
      .returning();
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: MessageThreadType.GROUP,
        groupAccount,
        groupDomain: 'local',
        groupAccountId: control.id,
        updatedAt: new Date(),
      })
      .returning();
    groupId = threadId = thread.id;

    await database.db.insert(relationshipPair).values({
      kind: 'GROUP_MEMBER',
      endpointAType: 'GROUP',
      endpointAAccount: groupAccount,
      endpointANamespaceId: 0,
      endpointBType: 'USER',
      endpointBAccount: ownerAccount,
      endpointBNamespaceId: 0,
      threadId,
      active: true,
      established: true,
    });

    await authorizePeer(peerDomain, peerNamespaceId, memberAccount);
    await authorizePeer(otherPeerDomain, otherPeerNamespaceId, observerAccount);
  });

  beforeEach(async () => {
    await database.db
      .delete(groupMetaMemberFeed)
      .where(eq(groupMetaMemberFeed.threadId, groupId));
    await database.db.delete(groupMeta).where(eq(groupMeta.threadId, groupId));
  });

  afterAll(async () => {
    await database.db.delete(message).where(eq(message.threadId, threadId));
    await database.db
      .delete(relationshipPair)
      .where(eq(relationshipPair.threadId, threadId));
    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId));
    await database.db
      .delete(groupAccountTable)
      .where(eq(groupAccountTable.account, groupAccount));
    await database.db.delete(user).where(eq(user.id, ownerUserId));
    await database.db
      .update(identityNamespace)
      .set({ active: false })
      .where(inArray(identityNamespace.domain, [peerDomain, otherPeerDomain]));
    await module.close();
  });

  async function authorizePeer(
    domain: string,
    namespaceId: number,
    remoteAccount: string,
  ): Promise<void> {
    const [_pair] = await database.db
      .insert(relationshipPair)
      .values({
        kind: 'GROUP_MEMBER',
        endpointAType: 'GROUP',
        endpointAAccount: groupAccount,
        endpointANamespaceId: 0,
        endpointBType: 'USER',
        endpointBAccount: remoteAccount,
        endpointBNamespaceId: namespaceId,
        threadId,
        active: true,
        established: true,
      })
      .returning({ id: relationshipPair.id });
    await database.db.insert(relationshipIntent).values({
      authorAccount: groupAccount,
      authorNamespaceId: 0,
      profileNamespaceId: 0,
      receiverAccount: remoteAccount,
      receiverNamespaceId: namespaceId,
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      status: 'ACCEPTED',
      profileRev: 1,
      note: '',
      requestedAt: new Date(),
      expiresAt: null,
    });
    await database.db.insert(threadAudience).values({
      targetDomain: domain,
      targetNamespaceId: namespaceId,
      threadId,
      messageAccessAfterSeq: 0,
    });
  }

  it('serves only the current Group Meta profile revision through exact account profiles', async () => {
    const profiles = new FederationProfileService(
      database,
      {} as never,
      {} as never,
    );
    await database.db.insert(profileTable).values(
      [1, 2, 3].map((profileRev) => ({
        account: groupAccount,
        namespaceId: 0,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev,
        displayName: `Group revision ${profileRev}`,
        avatar: '',
        bio: '',
      })),
    );
    try {
      await database.db.transaction((tx) =>
        feed.reconcileProfileInTx(tx, groupId, 2),
      );
      await expect(
        profiles.getAuthorizedAccountProfile(
          groupAccount,
          0,
          1,
          peerNamespaceId,
        ),
      ).resolves.toBeNull();
      await expect(
        profiles.getAuthorizedAccountProfile(
          groupAccount,
          0,
          2,
          peerNamespaceId,
        ),
      ).resolves.toMatchObject({ profileRev: 2 });
      await expect(
        profiles.getAuthorizedAccountProfile(
          groupAccount,
          0,
          3,
          peerNamespaceId,
        ),
      ).resolves.toBeNull();
      await expect(
        profiles.getAuthorizedAccountProfile(
          groupAccount,
          0,
          2,
          otherPeerNamespaceId,
        ),
      ).resolves.toMatchObject({ profileRev: 2 });
    } finally {
      await database.db
        .delete(profileTable)
        .where(
          and(
            eq(profileTable.account, groupAccount),
            eq(profileTable.profileNamespaceId, 0),
          ),
        );
    }
  });

  const owner = () => ({
    account: ownerAccount,
    profileNamespaceId: 0,
    role: GroupRole.OWNER,
    profileRev: 1,
  });

  const member = () => ({
    account: memberAccount,
    profileNamespaceId: peerNamespaceId,
    role: GroupRole.MEMBER,
    profileRev: 1,
  });

  async function reconcileDesired(
    tx: Parameters<GroupMetaFeedService['reconcileMembersInTx']>[0],
    members: readonly {
      account: string;
      profileNamespaceId: number;
      role: GroupRole;
      profileRev: number;
    }[],
  ): Promise<number> {
    await feed.reconcileMembersInTx(tx, groupId, [
      { ...owner(), operation: 'MEMBER_UPSERT' },
      members.some((item) => item.account === memberAccount)
        ? { ...member(), operation: 'MEMBER_UPSERT' }
        : {
            ...member(),
            operation: 'MEMBER_DEPART',
          },
    ]);
    return feed.reconcileProfileInTx(tx, groupId, 1);
  }

  it('serializes client announcement coordinates as decimal strings', async () => {
    await database.db.insert(groupMeta).values({
      threadId: groupId,
      metaEndId: 1,
      announcementFeedId: 1,
      announcementText: 'Welcome',
    });
    const page = await clientFeed.serve(
      ownerUserId,
      groupId,
      groupAccount,
      'full',
      0,
      100,
      1,
    );
    expect(page).toMatchObject({
      scannedThrough: '1',
      groupMetaFeedEndId: '1',
      items: [
        {
          feedId: '1',
          operation: 'GROUP_ANNOUNCEMENT',
          body: { text: 'Welcome' },
        },
      ],
    });
  });

  it('retains only the newest announcement, including clears and clipped full boundaries', async () => {
    await database.db.insert(groupMeta).values({
      threadId: groupId,
      metaEndId: 1,
      announcementFeedId: 1,
      announcementText: null,
    });
    const read = async (
      mode: 'full' | 'delta',
      after: number,
      through?: number,
    ) => {
      const [meta] = await database.db
        .select({ end: groupMeta.metaEndId })
        .from(groupMeta)
        .where(eq(groupMeta.threadId, groupId));
      return database.db.transaction((tx) =>
        readGroupMetaPageInTx(tx, {
          groupId,
          account: groupAccount,
          viewMode: 'federation',
          feedMode: mode,
          after,
          through,
          take: 100,
          end: meta.end,
          visibleAfter: 0,
        }),
      );
    };
    expect((await read('full', 0)).items).toEqual([
      {
        feedId: 1,
        operation: 'GROUP_ANNOUNCEMENT',
        body: { text: null },
      },
    ]);
    const published = await database.db.transaction((tx) =>
      feed.reconcileAnnouncementInTx(tx, groupId, 'Welcome'),
    );
    expect(published).toEqual({ feedId: 2, changed: true });
    expect(
      await database.db.transaction((tx) =>
        feed.reconcileAnnouncementInTx(tx, groupId, 'Welcome'),
      ),
    ).toEqual({ feedId: 2, changed: false });
    expect((await read('full', 0, 1)).items).toEqual([]);
    expect((await read('delta', 1)).items).toEqual([
      {
        feedId: 2,
        operation: 'GROUP_ANNOUNCEMENT',
        body: { text: 'Welcome' },
      },
    ]);
    expect(
      await database.db.transaction((tx) =>
        feed.reconcileAnnouncementInTx(tx, groupId, null),
      ),
    ).toEqual({ feedId: 3, changed: true });
    expect((await read('full', 0)).items).toEqual([
      {
        feedId: 3,
        operation: 'GROUP_ANNOUNCEMENT',
        body: { text: null },
      },
    ]);
    expect((await read('delta', 1)).items).toHaveLength(1);
  });

  it.each(['full', 'delta'] as const)(
    'includes client member namespaces and compact profile references in %s pages',
    async (mode) => {
      await database.db.transaction((tx) =>
        reconcileDesired(tx, [owner(), member()]),
      );
      const [head] = await database.db
        .select()
        .from(groupMeta)
        .where(eq(groupMeta.threadId, groupId));
      const page = await database.db.transaction((tx) =>
        readGroupMetaPageInTx(tx, {
          groupId,
          account: groupAccount,
          viewMode: 'client',
          feedMode: mode,
          after: 0,
          take: 100,
          end: head.metaEndId,
          visibleAfter: 0,
        }),
      );
      expect(page.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: 'MEMBER_UPSERT',
            body: {
              account: ownerAccount,
              namespaceId: 0,
              role: 'OWNER',
              profileRev: 1,
            },
          }),
          expect.objectContaining({
            operation: 'MEMBER_UPSERT',
            body: {
              account: memberAccount,
              namespaceId: peerNamespaceId,
              role: GroupRole.MEMBER,
              profileRev: 1,
            },
          }),
          expect.objectContaining({
            operation: 'GROUP_PROFILE',
            body: {
              account: groupAccount,
              namespaceId: 0,
              profileRev: 1,
            },
          }),
        ]),
      );
      const profile = page.items.find(
        (item) => item.operation === 'GROUP_PROFILE',
      )!;
      expect(profile).not.toHaveProperty('account');
      expect(profile).not.toHaveProperty('namespaceId');
    },
  );

  it('returns only the current roster in full and MEMBER_DEPART in delta', async () => {
    await database.db.transaction((tx) =>
      reconcileDesired(tx, [owner(), member()]),
    );
    await database.db.transaction((tx) => reconcileDesired(tx, [owner()]));

    const full = await publisher.serve(
      peerNamespaceId,
      groupAccount,
      'full',
      0,
    );
    expect(full).toMatchObject({
      groupMetaFeedEndId: 4,
      scannedThrough: 4,
      hasMore: false,
    });
    expect(full.items).toEqual([
      {
        feedId: 1,
        operation: 'MEMBER_UPSERT',
        body: {
          account: ownerAccount,
          namespaceId: 0,
          role: GroupRole.OWNER,
          profileRev: 1,
        },
      },
      {
        feedId: 3,
        operation: 'GROUP_PROFILE',
        body: { account: groupAccount, namespaceId: 0, profileRev: 1 },
      },
    ]);

    const delta = await publisher.serve(
      peerNamespaceId,
      groupAccount,
      'delta',
      3,
    );
    expect(delta.items).toEqual([
      {
        feedId: 4,
        operation: 'MEMBER_DEPART',
        body: {
          account: memberAccount,
          role: GroupRole.MEMBER,
          namespaceId: peerNamespaceId,
          profileRev: 1,
        },
      },
    ]);
  });

  it('resumes a bounded delta one feed item at a time', async () => {
    await database.db.transaction((tx) =>
      reconcileDesired(tx, [owner(), member()]),
    );

    const first = await publisher.serve(
      peerNamespaceId,
      groupAccount,
      'delta',
      0,
      1,
      3,
    );
    expect(first).toMatchObject({ scannedThrough: 1, hasMore: true });
    expect(first.items.map((item) => item.feedId)).toEqual([1]);

    const second = await publisher.serve(
      peerNamespaceId,
      groupAccount,
      'delta',
      1,
      1,
      3,
    );
    expect(second).toMatchObject({ scannedThrough: 2, hasMore: true });
    expect(second.items.map((item) => item.feedId)).toEqual([2]);

    const third = await publisher.serve(
      peerNamespaceId,
      groupAccount,
      'delta',
      2,
      1,
      3,
    );
    expect(third).toMatchObject({ scannedThrough: 3, hasMore: false });
    expect(third.items.map((item) => item.feedId)).toEqual([3]);
  });

  it('requires a cursor but has no retained-history boundary', async () => {
    await database.db.transaction((tx) =>
      reconcileDesired(tx, [owner(), member()]),
    );

    await expect(
      publisher.serve(peerNamespaceId, groupAccount, 'full', undefined),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      status: 200,
      data: { resumeAfter: 0, resumeBefore: 4 },
    });
  });

  it('truncates an older full boundary after compaction and converges through delta', async () => {
    await database.db.transaction((tx) =>
      reconcileDesired(tx, [owner(), member()]),
    );
    const first = await publisher.serve(
      peerNamespaceId,
      groupAccount,
      'full',
      0,
      1,
      3,
    );
    expect(first.hasMore).toBe(true);
    await database.db.transaction((tx) =>
      feed.appendMemberTransitionInTx(tx, groupId, {
        ...member(),
        role: GroupRole.ADMIN,
        operation: 'MEMBER_UPSERT',
      }),
    );
    const continued = await publisher.serve(
      peerNamespaceId,
      groupAccount,
      'full',
      first.scannedThrough,
      100,
      3,
    );
    expect(
      continued.items.some(
        (item) =>
          item.operation === 'MEMBER_UPSERT' &&
          item.body.account === memberAccount,
      ),
    ).toBe(false);
    const retried = await publisher.serve(
      peerNamespaceId,
      groupAccount,
      'full',
      0,
      100,
      3,
    );
    expect(retried.items.length).toBeLessThan(3);
    const delta = await publisher.serve(
      peerNamespaceId,
      groupAccount,
      'delta',
      3,
    );
    expect(delta.items).toEqual([
      expect.objectContaining({
        feedId: 4,
        operation: 'MEMBER_UPSERT',
        body: {
          account: memberAccount,
          role: GroupRole.ADMIN,
          namespaceId: peerNamespaceId,
          profileRev: 1,
        },
      }),
    ]);
  });

  it('appends a new MEMBER_UPSERT when a departed member rejoins', async () => {
    await database.db.transaction((tx) =>
      reconcileDesired(tx, [owner(), member()]),
    );
    await database.db.transaction((tx) => reconcileDesired(tx, [owner()]));
    await database.db.transaction((tx) =>
      reconcileDesired(tx, [owner(), member()]),
    );

    const delta = await publisher.serve(
      peerNamespaceId,
      groupAccount,
      'delta',
      4,
    );
    expect(delta.items).toEqual([
      {
        feedId: 5,
        operation: 'MEMBER_UPSERT',
        body: {
          account: memberAccount,
          role: GroupRole.MEMBER,
          namespaceId: peerNamespaceId,
          profileRev: 1,
        },
      },
    ]);
  });

  it('serves the same canonical coordinate space to every authorized peer', async () => {
    await database.db.transaction((tx) =>
      reconcileDesired(tx, [owner(), member()]),
    );

    const [first, second] = await Promise.all([
      publisher.serve(peerNamespaceId, groupAccount, 'full', 0),
      publisher.serve(otherPeerNamespaceId, groupAccount, 'full', 0),
    ]);
    expect(second).toEqual(first);
  });

  it('does not allocate a new item when the canonical facts are unchanged', async () => {
    const initial = await database.db.transaction((tx) =>
      reconcileDesired(tx, [owner(), member()]),
    );
    const unchanged = await database.db.transaction((tx) =>
      reconcileDesired(tx, [owner(), member()]),
    );

    expect(initial).toBe(3);
    expect(unchanged).toBe(initial);
  });
});
