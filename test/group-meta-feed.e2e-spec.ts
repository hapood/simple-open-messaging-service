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
  user,
} from '../src/database/schema.js';
import { MessageThreadType } from '../src/database/enums.js';
import { GroupMetaFeedService } from '../src/federation/group-meta-feed.service.js';

describe('group-meta compacted feed', () => {
  const suffix = Date.now().toString(36);
  const peerDomain = `group-meta-${suffix}.test`;
  const otherPeerDomain = `group-meta-other-${suffix}.test`;
  const groupAccount = `!groupmeta${suffix}`;
  const accounts = [groupAccount, `owner-${suffix}`, `member-${suffix}`];
  let mod: TestingModule;
  let database: DatabaseService;
  let feed: GroupMetaFeedService;
  let groupUserId: number;
  let threadId: number;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [GroupMetaFeedService],
    }).compile();
    database = mod.get(DatabaseService);
    feed = mod.get(GroupMetaFeedService);
    await database.db
      .insert(federatedPeer)
      .values([{ domain: peerDomain }, { domain: otherPeerDomain }]);
    const [owner, member, groupUser] = await database.db
      .insert(user)
      .values([
        {
          account: accounts[1],
          domain: 'local',
          name: 'Owner',
          isForeigner: false,
          updatedAt: new Date(),
        },
        {
          account: accounts[2],
          domain: peerDomain,
          name: 'Member',
          isForeigner: true,
          updatedAt: new Date(),
        },
        {
          account: groupAccount,
          domain: 'local',
          name: 'Group',
          isGroup: true,
          isForeigner: false,
          hashPwd: '',
          updatedAt: new Date(),
        },
      ])
      .returning({ id: user.id, account: user.account });
    groupUserId = groupUser.id;
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: MessageThreadType.GROUP,
        groupUserId,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await database.db.insert(group).values({
      groupUserId,
      ownerId: owner.id,
      updatedAt: new Date(),
    });
    void member;
  });

  afterAll(async () => {
    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId));
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
    domain: 'local.test',
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
    body: {
      role: 'MEMBER',
      profileRev: 1,
      displayName: 'Member',
      avatar: null,
    },
  };

  it('filters DELETE from full and retains it in delta', async () => {
    await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, peerDomain, groupUserId, [owner, member]),
    );
    await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, peerDomain, groupUserId, [owner]),
    );

    const full = await feed.serve(peerDomain, groupAccount, 'full', 0n);
    expect(full.groupMetaFeedEndId).toBe('3');
    expect(full.scannedThrough).toBe('3');
    expect(full.items.map((item) => item.account)).toEqual([accounts[1]]);
    expect(full.items[0].operation).toBe('UPSERT');

    const delta = await feed.serve(peerDomain, groupAccount, 'delta', 2n);
    expect(delta.items).toMatchObject([
      {
        feedId: '3',
        account: accounts[2],
        rev: 2,
        operation: 'DELETE',
        body: {},
      },
    ]);

    const firstPage = await feed.serve(
      peerDomain,
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
  });

  it('requires full when DELETE retention moved past the delta cursor', async () => {
    await database.db
      .update(groupMetaFeedTarget)
      .set({ oldestAvailableAfter: 3n })
      .where(
        and(
          eq(groupMetaFeedTarget.targetPeerDomain, peerDomain),
          eq(groupMetaFeedTarget.groupUserId, groupUserId),
        ),
      );
    await expect(
      feed.serve(peerDomain, groupAccount, 'delta', 2n),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      data: { resumeAfter: '0', resumeBefore: '4' },
    });
  });

  it('rejoining appends a newer member revision and feed id', async () => {
    await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, peerDomain, groupUserId, [owner, member]),
    );
    const delta = await feed.serve(peerDomain, groupAccount, 'delta', 3n);
    expect(delta.items).toMatchObject([
      { feedId: '4', account: accounts[2], rev: 3, operation: 'UPSERT' },
    ]);
  });

  it('preserves the allocator while authorization is inactive', async () => {
    await database.db.transaction((tx) =>
      feed.deactivateTargetInTx(tx, peerDomain, groupUserId),
    );
    await expect(
      feed.serve(peerDomain, groupAccount, 'full', 0n),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FORBIDDEN });

    const unchangedHead = await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, peerDomain, groupUserId, [owner, member]),
    );
    expect(unchangedHead).toBe(4n);
    const advancedHead = await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, peerDomain, groupUserId, [
        owner,
        {
          ...member,
          body: { ...member.body, profileRev: 2 },
        },
      ]),
    );
    expect(advancedHead).toBe(5n);
  });

  it('keeps the same member address independent for different source peers', async () => {
    await database.db.transaction((tx) =>
      feed.reconcileInTx(tx, otherPeerDomain, groupUserId, [
        owner,
        {
          ...member,
          body: { ...member.body, displayName: 'Different projection' },
        },
      ]),
    );
    const first = await feed.serve(peerDomain, groupAccount, 'full', 0n);
    const second = await feed.serve(otherPeerDomain, groupAccount, 'full', 0n);
    expect(
      first.items.find((item) => item.account === accounts[2])?.body,
    ).toMatchObject({ displayName: 'Member' });
    expect(
      second.items.find((item) => item.account === accounts[2])?.body,
    ).toMatchObject({ displayName: 'Different projection' });
  });
});
