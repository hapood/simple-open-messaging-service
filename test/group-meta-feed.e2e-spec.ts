import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federatedPeer,
  group,
  groupMetaFeedTarget,
  messageThread,
  threadAudience,
  threadMember,
  user,
} from '../src/database/schema.js';
import { MessageThreadType } from '../src/database/enums.js';
import { GroupMetaFeedService } from '../src/federation/group-meta-feed.service.js';
import { loadFederationConfig } from '../src/federation/federation.config.js';
import { seedFederatedPeerNamespace } from './seed.js';

describe('group-meta compacted feed', () => {
  const suffix = Date.now().toString(36);
  const peerDomain = `group-meta-${suffix}.test`;
  const otherPeerDomain = `group-meta-other-${suffix}.test`;
  const groupAccount = `!groupmeta${suffix}`;
  const localDomain = loadFederationConfig().domain;
  const accounts = [groupAccount, `owner-${suffix}`, `member-${suffix}`];
  let mod: TestingModule;
  let database: DatabaseService;
  let feed: GroupMetaFeedService;
  let groupId: number;
  let threadId: number;
  let ownerUserId: number;
  let memberUserId: number;
  let peerNamespaceId: number;
  let otherPeerNamespaceId: number;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [GroupMetaFeedService],
    }).compile();
    database = mod.get(DatabaseService);
    feed = mod.get(GroupMetaFeedService);
    peerNamespaceId = await seedFederatedPeerNamespace(
      database.db,
      peerDomain,
    );
    otherPeerNamespaceId = await seedFederatedPeerNamespace(
      database.db,
      otherPeerDomain,
    );
    const [owner, member] = await database.db
      .insert(user)
      .values([
        {
          account: accounts[1],
          domain: 'local',
          name: 'Owner',
          updatedAt: new Date(),
        },
        {
          account: accounts[2],
          domain: peerDomain,
          sourceDomain: peerDomain,
          namespaceId: peerNamespaceId,
          name: 'Member',
          updatedAt: new Date(),
        },
      ])
      .returning({ id: user.id, account: user.account });
    ownerUserId = owner.id;
    memberUserId = member.id;
    const [createdGroup] = await database.db
      .insert(group)
      .values({
        account: groupAccount,
        domain: 'local',
        name: 'Group',
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
    await database.db.insert(threadMember).values([
      {
        threadId,
        userId: ownerUserId,
        role: 'OWNER',
        updatedAt: new Date(),
      },
      {
        threadId,
        userId: memberUserId,
        role: 'MEMBER',
        updatedAt: new Date(),
      },
    ]);
    await database.db.insert(threadAudience).values([
      {
        targetDomain: peerDomain,
        targetNamespaceId: peerNamespaceId,
        threadId,
        messageAccessAfterSeq: 0,
      },
      {
        targetDomain: otherPeerDomain,
        targetNamespaceId: otherPeerNamespaceId,
        threadId,
        messageAccessAfterSeq: 0,
      },
    ]);
  });

  afterAll(async () => {
    await database.db
      .delete(threadMember)
      .where(eq(threadMember.threadId, threadId));
    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId));
    await database.db.delete(group).where(eq(group.id, groupId));
    await database.db
      .delete(user)
      .where(and(eq(user.domain, 'local'), inArray(user.account, accounts)));
    await database.db
      .delete(user)
      .where(and(eq(user.domain, peerDomain), eq(user.account, accounts[2])));
    await database.db
      .delete(federatedPeer)
      .where(inArray(federatedPeer.domain, [peerDomain, otherPeerDomain]));
    await mod.close();
  });

  const owner = {
    account: accounts[1],
    domain: localDomain,
    namespaceId: 0,
    body: {
      role: 'OWNER',
      profileRev: 1,
      displayName: 'Owner',
      avatar: null,
    },
  };
  const member = {
    account: accounts[2],
    domain: peerDomain,
    get namespaceId() {
      return peerNamespaceId;
    },
    body: {
      role: 'MEMBER',
      profileRev: 1,
      displayName: 'Member',
      avatar: null,
    },
  };

  it('returns the current roster in full and ordered changes in delta', async () => {
    await database.db.transaction((tx) =>
      feed.reconcileInTx(
        tx,
        peerDomain,
        peerNamespaceId,
        groupId,
        [owner, member],
      ),
    );
    await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, peerDomain, peerNamespaceId, groupId, [owner]),
    );
    await database.db
      .update(threadMember)
      .set({ left: true })
      .where(
        and(
          eq(threadMember.threadId, threadId),
          eq(threadMember.userId, memberUserId),
        ),
      );

    const full = await feed.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'full',
      0n,
    );
    expect(full.groupMetaFeedEndId).toBe('3');
    expect(full.scannedThrough).toBe('3');
    expect(full.items.map((item) => [item.account, item.operation])).toEqual([
      [accounts[1], 'UPSERT'],
    ]);

    const delta = await feed.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'delta',
      2n,
    );
    expect(delta.items).toMatchObject([
      {
        feedId: '3',
        account: accounts[2],
        operation: 'DEPART',
        body: member.body,
      },
    ]);

    const firstPage = await feed.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'delta',
      0n,
      1,
      3n,
    );
    expect(firstPage).toMatchObject({
      scannedThrough: '1',
      hasMore: true,
    });
    expect(firstPage.items.map((item) => item.feedId)).toEqual(['1']);
    const secondPage = await feed.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'delta',
      1n,
      1,
      3n,
    );
    expect(secondPage).toMatchObject({
      scannedThrough: '2',
      hasMore: true,
    });
    expect(secondPage.items.map((item) => item.feedId)).toEqual(['2']);

    await expect(
      feed.serve(peerDomain, peerNamespaceId, groupAccount, 'full', undefined),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      data: { resumeAfter: '0', resumeBefore: '4' },
    });
  });

  it('requires full when DEPART retention moved past the delta cursor', async () => {
    await database.db
      .update(groupMetaFeedTarget)
      .set({ oldestAvailableAfter: 3n })
      .where(
        and(
          eq(groupMetaFeedTarget.targetPeerDomain, peerDomain),
          eq(groupMetaFeedTarget.targetNamespaceId, peerNamespaceId),
          eq(groupMetaFeedTarget.groupId, groupId),
        ),
      );
    await expect(
      feed.serve(peerDomain, peerNamespaceId, groupAccount, 'delta', 2n),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      data: { resumeAfter: '0', resumeBefore: '4' },
    });
  });

  it('rejoining appends a newer feed id', async () => {
    await database.db
      .update(threadMember)
      .set({ left: false })
      .where(
        and(
          eq(threadMember.threadId, threadId),
          eq(threadMember.userId, memberUserId),
        ),
      );
    await database.db.transaction((tx) =>
      feed.reconcileInTx(
        tx,
        peerDomain,
        peerNamespaceId,
        groupId,
        [owner, member],
      ),
    );
    const delta = await feed.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'delta',
      3n,
    );
    expect(delta.items).toMatchObject([
      { feedId: '4', account: accounts[2], operation: 'UPSERT' },
    ]);
  });

  it('does not return departed members or DEPART items in full mode', async () => {
    await database.db
      .update(threadMember)
      .set({ left: true })
      .where(
        and(
          eq(threadMember.threadId, threadId),
          eq(threadMember.userId, memberUserId),
        ),
      );
    await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, peerDomain, peerNamespaceId, groupId, [owner]),
    );

    const full = await feed.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'full',
      0n,
    );
    expect(full.items.map((item) => [item.account, item.operation])).toEqual([
      [accounts[1], 'UPSERT'],
    ]);
    const delta = await feed.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'delta',
      4n,
    );
    expect(delta.items).toMatchObject([
      {
        feedId: '5',
        account: accounts[2],
        operation: 'DEPART',
        body: member.body,
      },
    ]);

    await database.db
      .update(threadMember)
      .set({ left: false })
      .where(
        and(
          eq(threadMember.threadId, threadId),
          eq(threadMember.userId, memberUserId),
        ),
      );
    await database.db.transaction((tx) =>
      feed.reconcileInTx(
        tx,
        peerDomain,
        peerNamespaceId,
        groupId,
        [owner, member],
      ),
    );
  });

  it('preserves the allocator while authorization is inactive', async () => {
    await database.db.transaction((tx) =>
      feed.deactivateTargetInTx(tx, peerDomain, peerNamespaceId, groupId),
    );
    await expect(
      feed.serve(peerDomain, peerNamespaceId, groupAccount, 'full', 0n),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FORBIDDEN });

    const unchangedHead = await database.db.transaction((tx) =>
      feed.reconcileInTx(
        tx,
        peerDomain,
        peerNamespaceId,
        groupId,
        [owner, member],
      ),
    );
    expect(unchangedHead).toBe(6n);
    const advancedHead = await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, peerDomain, peerNamespaceId, groupId, [
        owner,
        {
          ...member,
          body: { ...member.body, profileRev: 2 },
        },
      ]),
    );
    expect(advancedHead).toBe(7n);
  });

  it('keeps the same member address independent for different source peers', async () => {
    await database.db.transaction((tx) =>
      feed.reconcileInTx(
        tx,
        otherPeerDomain,
        otherPeerNamespaceId,
        groupId,
        [
        owner,
        {
          ...member,
          body: { ...member.body, displayName: 'Different projection' },
        },
        ],
      ),
    );
    const first = await feed.serve(
      peerDomain,
      peerNamespaceId,
      groupAccount,
      'full',
      0n,
    );
    const second = await feed.serve(
      otherPeerDomain,
      otherPeerNamespaceId,
      groupAccount,
      'full',
      0n,
    );
    expect(
      first.items.find((item) => item.account === accounts[2])?.body,
    ).toMatchObject({ displayName: 'Member' });
    expect(
      second.items.find((item) => item.account === accounts[2])?.body,
    ).toMatchObject({ displayName: 'Different projection' });
  });
});
