import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federatedPeer,
  group,
  groupMetaFeed,
  groupMetaMemberFeed,
  groupMetaProfileFeed,
  messageThread,
  profileVersion,
  relationshipIntent,
  relationshipPair,
  threadAudience,
  user,
} from '../src/database/schema.js';
import { GroupRole, MessageThreadType } from '../src/database/enums.js';
import { loadFederationConfig } from '../src/federation/federation.config.js';
import { GroupMetaFeedService } from '../src/federation/group-meta-feed.service.js';
import { seedFederatedPeerNamespace } from './seed.js';

describe('canonical Group Meta feed', () => {
  const suffix = Date.now().toString(36);
  const peerDomain = `group-meta-${suffix}.test`;
  const otherPeerDomain = `group-meta-other-${suffix}.test`;
  const groupAccount = `!groupmeta${suffix}`;
  const ownerAccount = `owner-${suffix}`;
  const memberAccount = `member-${suffix}`;
  const observerAccount = `observer-${suffix}`;
  const localDomain = loadFederationConfig().domain;
  let module: TestingModule;
  let database: DatabaseService;
  let feed: GroupMetaFeedService;
  let groupId: number;
  let threadId: number;
  let ownerUserId: number;
  let memberUserId: number;
  let observerUserId: number;
  let peerNamespaceId: number;
  let otherPeerNamespaceId: number;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [GroupMetaFeedService],
    }).compile();
    database = module.get(DatabaseService);
    feed = module.get(GroupMetaFeedService);
    peerNamespaceId = await seedFederatedPeerNamespace(database.db, peerDomain);
    otherPeerNamespaceId = await seedFederatedPeerNamespace(
      database.db,
      otherPeerDomain,
    );

    const identities = await database.db
      .insert(user)
      .values([
        {
          account: ownerAccount,
          domain: 'local',
          namespaceId: 0,
          name: 'Owner',
          defaultProfileRev: 1,
          updatedAt: new Date(),
        },
        {
          account: memberAccount,
          domain: peerDomain,
          namespaceId: peerNamespaceId,
          name: 'Member',
          defaultProfileRev: 1,
          updatedAt: new Date(),
        },
        {
          account: observerAccount,
          domain: otherPeerDomain,
          namespaceId: otherPeerNamespaceId,
          name: 'Observer',
          defaultProfileRev: 1,
          updatedAt: new Date(),
        },
      ])
      .returning({ id: user.id, account: user.account });
    ownerUserId = identities.find(
      (identity) => identity.account === ownerAccount,
    )!.id;
    memberUserId = identities.find(
      (identity) => identity.account === memberAccount,
    )!.id;
    observerUserId = identities.find(
      (identity) => identity.account === observerAccount,
    )!.id;
    await database.db.insert(profileVersion).values({
      userId: ownerUserId,
      profileRev: 1,
      displayName: 'Owner',
      avatar: '',
      bio: '',
    });

    const [createdGroup] = await database.db
      .insert(group)
      .values({
        account: groupAccount,
        domain: 'local',
        namespaceId: 0,
        name: 'Group',
        defaultProfileRev: 1,
        updatedAt: new Date(),
      })
      .returning({ id: group.id });
    groupId = createdGroup.id;
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: MessageThreadType.GROUP,
        groupId,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    threadId = thread.id;

    await authorizePeer(peerDomain, peerNamespaceId, memberAccount);
    await authorizePeer(otherPeerDomain, otherPeerNamespaceId, observerAccount);
  });

  beforeEach(async () => {
    await database.db
      .delete(groupMetaMemberFeed)
      .where(eq(groupMetaMemberFeed.groupId, groupId));
    await database.db
      .delete(groupMetaProfileFeed)
      .where(eq(groupMetaProfileFeed.groupId, groupId));
    await database.db
      .delete(groupMetaFeed)
      .where(eq(groupMetaFeed.groupId, groupId));
  });

  afterAll(async () => {
    await database.db
      .delete(relationshipPair)
      .where(eq(relationshipPair.threadId, threadId));
    await database.db.delete(group).where(eq(group.id, groupId));
    await database.db
      .delete(user)
      .where(inArray(user.id, [ownerUserId, memberUserId, observerUserId]));
    await database.db
      .delete(federatedPeer)
      .where(inArray(federatedPeer.domain, [peerDomain, otherPeerDomain]));
    await module.close();
  });

  async function authorizePeer(
    domain: string,
    namespaceId: number,
    remoteAccount: string,
  ): Promise<void> {
    const [pair] = await database.db
      .insert(relationshipPair)
      .values({
        kind: 'GROUP_MEMBER',
        endpointAType: 'GROUP',
        endpointAAccount: groupAccount,
        endpointADomain: 'local',
        endpointANamespaceId: namespaceId,
        endpointBType: 'USER',
        endpointBAccount: remoteAccount,
        endpointBDomain: domain,
        endpointBNamespaceId: namespaceId,
        threadId,
        active: true,
      })
      .returning({ id: relationshipPair.id });
    await database.db.insert(relationshipIntent).values({
      pairId: pair.id,
      authorSide: 'A',
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

  const owner = () => ({
    userId: ownerUserId,
    account: ownerAccount,
    domain: 'local',
    body: { role: GroupRole.OWNER, profileRev: 1 },
  });

  const member = () => ({
    userId: memberUserId,
    account: memberAccount,
    domain: peerDomain,
    body: { role: GroupRole.MEMBER, profileRev: 1 },
  });

  it('returns only the current roster in full and a bodyless DEPART in delta', async () => {
    await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, groupId, 1, [owner(), member()]),
    );
    await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, groupId, 1, [owner()]),
    );

    const full = await feed.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'full',
      0n,
    );
    expect(full).toMatchObject({
      groupMetaFeedEndId: '4',
      scannedThrough: '4',
      hasMore: false,
    });
    expect(full.items).toEqual([
      {
        feedId: '2',
        account: ownerAccount,
        domain: localDomain,
        operation: 'UPSERT',
        body: { role: GroupRole.OWNER, profileRev: 1 },
      },
      {
        feedId: '3',
        operation: 'GROUP_PROFILE',
        body: { profileRev: 1 },
      },
    ]);

    const delta = await feed.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'delta',
      3n,
    );
    expect(delta.items).toEqual([
      {
        feedId: '4',
        account: memberAccount,
        domain: peerDomain,
        operation: 'DEPART',
      },
    ]);
  });

  it('resumes a bounded delta one feed item at a time', async () => {
    await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, groupId, 1, [owner(), member()]),
    );

    const first = await feed.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'delta',
      0n,
      1,
      3n,
    );
    expect(first).toMatchObject({ scannedThrough: '1', hasMore: true });
    expect(first.items.map((item) => item.feedId)).toEqual(['1']);

    const second = await feed.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'delta',
      1n,
      1,
      3n,
    );
    expect(second).toMatchObject({ scannedThrough: '2', hasMore: true });
    expect(second.items.map((item) => item.feedId)).toEqual(['2']);

    const third = await feed.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'delta',
      2n,
      1,
      3n,
    );
    expect(third).toMatchObject({ scannedThrough: '3', hasMore: false });
    expect(third.items.map((item) => item.feedId)).toEqual(['3']);
  });

  it('requires a cursor but has no retained-history boundary', async () => {
    await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, groupId, 1, [owner(), member()]),
    );

    await expect(
      feed.serve(peerDomain, peerNamespaceId, groupAccount, 'full', undefined),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      status: 200,
      data: { resumeAfter: '0', resumeBefore: '4' },
    });
  });

  it('appends a new UPSERT when a departed member rejoins', async () => {
    await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, groupId, 1, [owner(), member()]),
    );
    await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, groupId, 1, [owner()]),
    );
    await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, groupId, 1, [owner(), member()]),
    );

    const delta = await feed.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'delta',
      4n,
    );
    expect(delta.items).toEqual([
      {
        feedId: '5',
        account: memberAccount,
        domain: peerDomain,
        operation: 'UPSERT',
        body: { role: GroupRole.MEMBER, profileRev: 1 },
      },
    ]);
  });

  it('serves the same canonical coordinate space to every authorized peer', async () => {
    await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, groupId, 1, [owner(), member()]),
    );

    const [first, second] = await Promise.all([
      feed.serve(peerDomain, peerNamespaceId, groupAccount, 'full', 0n),
      feed.serve(
        otherPeerDomain,
        otherPeerNamespaceId,
        groupAccount,
        'full',
        0n,
      ),
    ]);
    expect(second).toEqual(first);
  });

  it('does not allocate a new item when the canonical facts are unchanged', async () => {
    const initial = await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, groupId, 1, [owner(), member()]),
    );
    const unchanged = await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, groupId, 1, [owner(), member()]),
    );

    expect(initial).toBe(3n);
    expect(unchanged).toBe(initial);
  });

  it('maps a public local-member address back to canonical storage for profile authorization', async () => {
    await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, groupId, 1, [owner(), member()]),
    );

    await expect(
      feed.resolveAllocatedMemberProfile(
        peerDomain,
        peerNamespaceId,
        groupAccount,
        ownerAccount,
        localDomain,
        1,
      ),
    ).resolves.toEqual({ memberNamespaceId: 0 });
  });
});
