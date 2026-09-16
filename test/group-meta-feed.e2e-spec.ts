import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federatedPeer,
  groupAccount as groupAccountTable,
  groupMeta,
  groupMetaMemberFeed,
  messageThread,
  message,
  peerStateFeed,
  profileTable,
  relationshipIntent,
  relationshipPair,
  threadAudience,
  account as user,
} from '../src/database/schema.js';
import { GroupRole, MessageThreadType } from '../src/database/enums.js';
import { loadFederationConfig } from '../src/federation/federation.config.js';
import { GroupMetaFeedService } from '../src/group/business/meta/group-meta-feed.service.js';
import { FederationGroupMetaFeedService } from '../src/federation/group-meta-feed.service.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { FederationMessageFeedService } from '../src/federation/federation-message-feed.service.js';
import { FederationProfileService } from '../src/federation/federation-profile.service.js';
import { S2sController } from '../src/federation/s2s.controller.js';
import { readGroupMetaPageInTx } from '../src/group/business/meta/group-meta-page.js';

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
  let publisher: FederationGroupMetaFeedService;
  let groupId: number;
  let threadId: number;
  let ownerUserId: number;
  let peerNamespaceId: number;
  let otherPeerNamespaceId: number;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [GroupMetaFeedService, FederationGroupMetaFeedService],
    }).compile();
    database = module.get(DatabaseService);
    feed = module.get(GroupMetaFeedService);
    publisher = module.get(FederationGroupMetaFeedService);
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
      domain: 'local',
      namespaceId: 0,
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
      endpointADomain: 'local',
      endpointANamespaceId: 0,
      endpointBType: 'USER',
      endpointBAccount: ownerAccount,
      endpointBDomain: 'local',
      endpointBNamespaceId: 0,
      threadId,
      active: true,
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
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
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

  it('serves an intent-referenced group revision after the current profile advances', async () => {
    const [pair] = await database.db
      .select({ id: relationshipPair.id })
      .from(relationshipPair)
      .where(
        and(
          eq(relationshipPair.threadId, threadId),
          eq(relationshipPair.endpointBDomain, peerDomain),
        ),
      );
    const profiles = new FederationProfileService(
      database,
      {} as never,
      {} as never,
    );
    await database.db.insert(profileTable).values(
      [1, 2, 3].map((profileRev) => ({
        account: groupAccount,
        domain: 'local',
        namespaceId: 0,
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
        profiles.getAuthorizedLocalProfile(
          groupAccount,
          1,
          peerDomain,
          peerNamespaceId,
        ),
      ).resolves.toMatchObject({
        profileRev: 1,
        displayName: 'Group revision 1',
      });
      await expect(
        profiles.getAuthorizedLocalProfile(
          groupAccount,
          2,
          peerDomain,
          peerNamespaceId,
        ),
      ).resolves.toMatchObject({ profileRev: 2 });
      await expect(
        profiles.getAuthorizedLocalProfile(
          groupAccount,
          3,
          peerDomain,
          peerNamespaceId,
        ),
      ).rejects.toMatchObject({
        bizCode: BusinessCode.FEDERATION_PROFILE_NOT_DISCLOSED,
      });
      await expect(
        profiles.getAuthorizedLocalProfile(
          groupAccount,
          1,
          peerDomain,
          otherPeerNamespaceId,
        ),
      ).rejects.toMatchObject({
        bizCode: BusinessCode.FEDERATION_PROFILE_NOT_DISCLOSED,
      });
      for (const expired of [false, true]) {
        await database.db
          .update(relationshipIntent)
          .set({
            status: 'REQUESTED',
            requestedAt: new Date(Date.now() - 120_000),
            expiresAt: new Date(Date.now() + (expired ? -60_000 : 60_000)),
          })
          .where(eq(relationshipIntent.pairId, pair.id));
        const result = profiles.getAuthorizedLocalProfile(
          groupAccount,
          1,
          peerDomain,
          peerNamespaceId,
        );
        if (expired) {
          await expect(result).rejects.toMatchObject({
            bizCode: BusinessCode.FEDERATION_PROFILE_NOT_DISCLOSED,
          });
        } else {
          await expect(result).resolves.toMatchObject({ profileRev: 1 });
        }
      }
      await database.db
        .update(relationshipIntent)
        .set({ status: 'REVOKED', expiresAt: null })
        .where(eq(relationshipIntent.pairId, pair.id));
      await expect(
        profiles.getAuthorizedLocalProfile(
          groupAccount,
          1,
          peerDomain,
          peerNamespaceId,
        ),
      ).rejects.toMatchObject({
        bizCode: BusinessCode.FEDERATION_PROFILE_NOT_DISCLOSED,
      });
    } finally {
      await database.db
        .update(relationshipIntent)
        .set({ status: 'ACCEPTED', expiresAt: null })
        .where(eq(relationshipIntent.pairId, pair.id));
      await database.db
        .delete(profileTable)
        .where(
          and(
            eq(profileTable.account, groupAccount),
            eq(profileTable.domain, 'local'),
            eq(profileTable.namespaceId, 0),
          ),
        );
    }
  });

  it('serves a third-party message author profile from its captured namespace, not the requesting peer', async () => {
    await database.db.insert(profileTable).values({
      account: memberAccount,
      domain: peerDomain,
      namespaceId: peerNamespaceId,
      profileRev: 7,
      displayName: 'Historical member',
    });
    // The same address through another publisher must not win the exact lookup.
    await database.db.insert(profileTable).values({
      account: memberAccount,
      domain: peerDomain,
      namespaceId: otherPeerNamespaceId,
      profileRev: 7,
      displayName: 'Wrong namespace',
    });
    await database.db.insert(message).values({
      threadId,
      seq: 7,
      originSeq: 5,
      sourceNamespaceId: peerNamespaceId,
      creatorAccount: memberAccount,
      creatorDomain: peerDomain,
      creatorNamespaceId: peerNamespaceId,
      profileRev: 7,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: 'third-party author' }),
      updatedAt: new Date(),
    });
    await database.db.insert(peerStateFeed).values({
      peerDomain: otherPeerDomain,
      namespaceId: otherPeerNamespaceId,
      account: groupAccount,
      domain: localDomain,
      eventType: 'THREAD_CONTENT_HEAD',
      subjectAccount: '',
      subjectDomain: 'local',
      feedId: 1n,
      body: { messageEndSeq: 7, tombstoneEndSeq: 0 },
    });
    const profiles = new FederationProfileService(
      database,
      {} as never,
      {} as never,
    );
    const controller = new S2sController(
      {
        ourDomain: localDomain,
        getStoredProfile: profiles.getStoredProfile.bind(profiles),
      } as never,
      new FederationMessageFeedService(database),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      feed,
    );
    const request = {
      query: { account: groupAccount, messageSeq: '7' },
      peer: { domain: otherPeerDomain, namespaceId: otherPeerNamespaceId },
    } as unknown as FastifyRequest;
    try {
      const result = await controller.getMessageAuthorProfile(
        request,
        groupAccount,
        undefined,
        '7',
      );
      expect(result).toMatchObject({
        account: memberAccount,
        domain: peerDomain,
        profileRev: 7,
        displayName: 'Historical member',
      });
      await database.db
        .delete(profileTable)
        .where(
          and(
            eq(profileTable.account, memberAccount),
            eq(profileTable.domain, peerDomain),
            eq(profileTable.namespaceId, otherPeerNamespaceId),
          ),
        );
      await expect(
        controller.getMessageAuthorProfile(
          request,
          groupAccount,
          undefined,
          '7',
        ),
      ).resolves.toMatchObject({
        displayName: 'Historical member',
        profileRev: 7,
      });
      const messageFeed = new FederationMessageFeedService(database);
      const page = await messageFeed.query(
        otherPeerDomain,
        otherPeerNamespaceId,
        { type: 'GROUP', account: groupAccount },
        6,
        1,
        7,
      );
      expect(page).not.toHaveProperty('authorReferences');
      expect(page.messages[0]).not.toHaveProperty('namespaceId');
      await database.db
        .update(message)
        .set({ isDeleted: true })
        .where(eq(message.threadId, threadId));
      await expect(
        controller.getMessageAuthorProfile(
          request,
          groupAccount,
          undefined,
          '7',
        ),
      ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
    } finally {
      await database.db.delete(message).where(eq(message.threadId, threadId));
      await database.db
        .delete(peerStateFeed)
        .where(eq(peerStateFeed.account, groupAccount));
    }
  });

  const owner = () => ({
    account: ownerAccount,
    domain: 'local',
    body: { role: GroupRole.OWNER, profileRev: 1 },
  });

  const member = () => ({
    account: memberAccount,
    domain: peerDomain,
    body: { role: GroupRole.MEMBER, profileRev: 1 },
  });

  async function reconcileDesired(
    tx: Parameters<GroupMetaFeedService['reconcileMembersInTx']>[0],
    members: readonly {
      account: string;
      domain: string;
      body: Record<string, unknown>;
    }[],
  ): Promise<number> {
    await feed.reconcileMembersInTx(tx, groupId, [
      { ...owner(), operation: 'UPSERT' },
      members.some((item) => item.account === memberAccount)
        ? { ...member(), operation: 'UPSERT' }
        : {
            account: memberAccount,
            domain: peerDomain,
            body: {},
            operation: 'DEPART',
          },
    ]);
    return feed.reconcileProfileInTx(tx, groupId, 1);
  }

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
          mode,
          after: 0,
          take: 100,
          end: head.metaEndId,
          visibleAfter: 0,
          client: { localDomain },
        }),
      );
      expect(page.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            account: ownerAccount,
            domain: 'local',
            namespaceId: 0,
            operation: 'UPSERT',
            body: { role: 'OWNER', profileRev: 1 },
          }),
          expect.objectContaining({
            account: memberAccount,
            domain: peerDomain,
            namespaceId: peerNamespaceId,
            operation: 'UPSERT',
          }),
          expect.objectContaining({
            operation: 'GROUP_PROFILE',
            body: { profileRev: 1 },
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

  it('returns only the current roster in full and a bodyless DEPART in delta', async () => {
    await database.db.transaction((tx) =>
      reconcileDesired(tx, [owner(), member()]),
    );
    await database.db.transaction((tx) => reconcileDesired(tx, [owner()]));

    const full = await publisher.serve(
      peerDomain,
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
        feedId: 2,
        account: ownerAccount,
        domain: localDomain,
        operation: 'UPSERT',
        body: { role: GroupRole.OWNER, profileRev: 1 },
      },
      {
        feedId: 3,
        operation: 'GROUP_PROFILE',
        body: { profileRev: 1 },
      },
    ]);

    const delta = await publisher.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'delta',
      3,
    );
    expect(delta.items).toEqual([
      {
        feedId: 4,
        account: memberAccount,
        domain: peerDomain,
        operation: 'DEPART',
      },
    ]);
  });

  it('resumes a bounded delta one feed item at a time', async () => {
    await database.db.transaction((tx) =>
      reconcileDesired(tx, [owner(), member()]),
    );

    const first = await publisher.serve(
      peerDomain,
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
      peerDomain,
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
      peerDomain,
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
      publisher.serve(
        peerDomain,
        peerNamespaceId,
        groupAccount,
        'full',
        undefined,
      ),
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
      peerDomain,
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
        operation: 'UPSERT',
        body: { role: GroupRole.ADMIN, profileRev: 1 },
      }),
    );
    const continued = await publisher.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'full',
      first.scannedThrough,
      100,
      3,
    );
    expect(
      continued.items.some(
        (item) => 'account' in item && item.account === memberAccount,
      ),
    ).toBe(false);
    const retried = await publisher.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'full',
      0,
      100,
      3,
    );
    expect(retried.items.length).toBeLessThan(3);
    const delta = await publisher.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'delta',
      3,
    );
    expect(delta.items).toEqual([
      expect.objectContaining({
        feedId: 4,
        account: memberAccount,
        operation: 'UPSERT',
        body: { role: GroupRole.ADMIN, profileRev: 1 },
      }),
    ]);
  });

  it('appends a new UPSERT when a departed member rejoins', async () => {
    await database.db.transaction((tx) =>
      reconcileDesired(tx, [owner(), member()]),
    );
    await database.db.transaction((tx) => reconcileDesired(tx, [owner()]));
    await database.db.transaction((tx) =>
      reconcileDesired(tx, [owner(), member()]),
    );

    const delta = await publisher.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'delta',
      4,
    );
    expect(delta.items).toEqual([
      {
        feedId: 5,
        account: memberAccount,
        domain: peerDomain,
        operation: 'UPSERT',
        body: { role: GroupRole.MEMBER, profileRev: 1 },
      },
    ]);
  });

  it('serves the same canonical coordinate space to every authorized peer', async () => {
    await database.db.transaction((tx) =>
      reconcileDesired(tx, [owner(), member()]),
    );

    const [first, second] = await Promise.all([
      publisher.serve(peerDomain, peerNamespaceId, groupAccount, 'full', 0),
      publisher.serve(
        otherPeerDomain,
        otherPeerNamespaceId,
        groupAccount,
        'full',
        0,
      ),
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

  it('maps a public local-member address back to canonical storage for profile authorization', async () => {
    await database.db.transaction((tx) =>
      reconcileDesired(tx, [owner(), member()]),
    );

    await database.db
      .update(relationshipPair)
      .set({ active: false })
      .where(
        and(
          eq(relationshipPair.threadId, threadId),
          eq(relationshipPair.endpointBAccount, ownerAccount),
        ),
      );

    await expect(
      publisher.resolveAllocatedMemberProfile(
        peerDomain,
        peerNamespaceId,
        groupAccount,
        ownerAccount,
        localDomain,
        1,
      ),
    ).resolves.toBe(0);
    await database.db
      .update(relationshipPair)
      .set({ active: true })
      .where(
        and(
          eq(relationshipPair.threadId, threadId),
          eq(relationshipPair.endpointBAccount, ownerAccount),
        ),
      );
  });
});
