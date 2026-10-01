import { UserService } from '../src/user/user.service.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { lockBusinessAccountsInTx } from '../src/common/locks/account-business-lock.js';
import { requireThreadContentLockInTx } from '../src/common/locks/thread-content-lock.js';
import { publishMemberMessageProfileInTx } from '../src/group/meta/publish-member-message-profile-in-tx.js';
import { GroupMetaFeedService } from '../src/group/meta/group-meta-feed.service.js';
import { upsertCurrentGroupMetaFactsInTx } from '../src/group/meta/current-group-meta-fact.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { GroupRole } from '../src/database/enums.js';
import {
  groupAccount as group,
  messageThread,
  groupMetaMemberFeed,
  groupMeta,
  message,
  profileTable,
  relationshipPair,
  account as user,
} from '../src/database/schema.js';
import { readCurrentGroupRosterInTx } from '../src/group/meta/current-group-roster.js';

describe('current Group Meta roster', () => {
  const suffix = Date.now().toString(36);
  let module: TestingModule;
  let database: DatabaseService;
  let groupId: number;
  let pairId: bigint;
  let remotePairId: bigint | undefined;
  let userIds: number[];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = module.get(DatabaseService);
    const identities = await database.db
      .insert(user)
      .values([
        {
          account: `owner-${suffix}`,
          domain: 'local',
          namespaceId: 0,
          updatedAt: new Date(),
        },
        {
          account: `departed-${suffix}`,
          domain: 'local',
          namespaceId: 0,
          updatedAt: new Date(),
        },
      ])
      .returning({ id: user.id });
    userIds = identities.map((identity) => identity.id);
    const [createdGroup] = await database.db
      .insert(group)
      .values({
        account: `!roster-${suffix}`,
        updatedAt: new Date(),
      })
      .returning({ id: group.id });
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'GROUP',
        groupAccount: `!roster-${suffix}`,
        groupDomain: 'local',
        groupAccountId: createdGroup.id,
        authorityNamespaceId: 0,
        updatedAt: new Date(),
      })
      .returning();
    groupId = thread.id;
    const [pair] = await database.db
      .insert(relationshipPair)
      .values({
        kind: 'GROUP_MEMBER',
        threadId: groupId,
        endpointAType: 'GROUP',
        endpointAAccount: `!roster-${suffix}`,
        endpointBType: 'USER',
        endpointBAccount: `owner-${suffix}`,
        active: true,
        established: true,
      })
      .returning({ id: relationshipPair.id });
    pairId = pair.id;
    await database.db
      .insert(groupMeta)
      .values({ threadId: groupId, metaEndId: 3 });
    await database.db.insert(groupMetaMemberFeed).values([
      {
        threadId: groupId,
        feedId: 1,
        memberAccount: `owner-${suffix}`,
        memberDomain: 'local',
        operation: 'MEMBER_UPSERT',
        body: { role: GroupRole.OWNER, profileRev: 1 },
      },
      {
        threadId: groupId,
        feedId: 3,
        memberAccount: `departed-${suffix}`,
        memberDomain: 'local',
        operation: 'MEMBER_DEPART',
        body: {},
        profileSourceSeq: 2,
      },
    ]);
  });

  afterAll(async () => {
    await database.db.delete(message).where(eq(message.threadId, groupId));
    if (remotePairId !== undefined)
      await database.db
        .delete(relationshipPair)
        .where(eq(relationshipPair.id, remotePairId));
    await database.db
      .delete(relationshipPair)
      .where(eq(relationshipPair.id, pairId));
    await database.db
      .delete(messageThread)
      .where(inArray(messageThread.id, [groupId]));
    await database.db.delete(group);
    await database.db.delete(user).where(inArray(user.id, userIds));
    await module.close();
  });

  it('selects only the newest active operation for each stable member', async () => {
    const roster = await database.db.transaction((tx) =>
      readCurrentGroupRosterInTx(tx, groupId),
    );

    expect(roster).toEqual([
      expect.objectContaining({
        account: `owner-${suffix}`,
        domain: 'local',
        namespaceId: 0,
        role: GroupRole.OWNER,
        profileRev: 1,
      }),
    ]);
  });
  it('does not publish member Meta when a local user edits their profile', async () => {
    const service = new UserService(database);
    await service.updateProfile(userIds[0], { name: 'First', bio: '' });
    await service.updateProfile(userIds[0], { name: 'Second', bio: '' });
    const roster = await database.db.transaction((tx) =>
      readCurrentGroupRosterInTx(tx, groupId),
    );
    expect(roster).toEqual([
      expect.objectContaining({
        account: `owner-${suffix}`,
        role: GroupRole.OWNER,
        profileRev: 1,
      }),
    ]);
    const [fact] = await database.db
      .select({ feedId: groupMetaMemberFeed.feedId })
      .from(groupMetaMemberFeed)
      .where(
        and(
          eq(groupMetaMemberFeed.threadId, groupId),
          eq(groupMetaMemberFeed.memberAccount, `owner-${suffix}`),
        ),
      );
    expect(fact.feedId).toBe(1);
  });

  it('retains departure evidence but clears it on rejoin across both writers', async () => {
    const account = `departed-${suffix}`;
    const current = () =>
      database.db.query.groupMetaMemberFeed.findFirst({
        where: and(
          eq(groupMetaMemberFeed.threadId, groupId),
          eq(groupMetaMemberFeed.memberAccount, account),
        ),
      });
    expect(await current()).toMatchObject({
      operation: 'MEMBER_DEPART',
      profileSourceSeq: 2,
    });
    const feedId = await database.db.transaction((tx) =>
      new GroupMetaFeedService().appendMemberTransitionInTx(tx, groupId, {
        account,
        domain: 'local',
        operation: 'MEMBER_UPSERT',
        body: { role: GroupRole.MEMBER, profileRev: 1 },
      }),
    );
    expect(feedId).toBe(4);
    expect(await current()).toMatchObject({
      operation: 'MEMBER_UPSERT',
      profileSourceSeq: null,
    });
    await database.db.transaction(async (tx) => {
      await tx
        .update(groupMetaMemberFeed)
        .set({ profileSourceSeq: 9 })
        .where(
          and(
            eq(groupMetaMemberFeed.threadId, groupId),
            eq(groupMetaMemberFeed.memberAccount, account),
          ),
        );
      await upsertCurrentGroupMetaFactsInTx(tx, [
        {
          threadId: groupId,
          feedId: 5,
          memberAccount: account,
          memberDomain: 'local',
          operation: 'MEMBER_DEPART',
          body: {},
        },
      ]);
      await tx
        .update(groupMeta)
        .set({ metaEndId: 5 })
        .where(eq(groupMeta.threadId, groupId));
    });
    expect(await current()).toMatchObject({
      operation: 'MEMBER_DEPART',
      profileSourceSeq: 9,
    });
    await database.db.transaction(async (tx) => {
      await upsertCurrentGroupMetaFactsInTx(tx, [
        {
          threadId: groupId,
          feedId: 6,
          memberAccount: account,
          memberDomain: 'local',
          operation: 'MEMBER_UPSERT',
          body: { role: GroupRole.MEMBER, profileRev: 3 },
        },
      ]);
      await tx
        .update(groupMeta)
        .set({ metaEndId: 6 })
        .where(eq(groupMeta.threadId, groupId));
    });
    expect(await current()).toMatchObject({
      operation: 'MEMBER_UPSERT',
      profileSourceSeq: null,
      body: { role: GroupRole.MEMBER, profileRev: 3 },
    });
  });

  it('publishes only a current, available member message in a new Meta item', async () => {
    const memberAccount = `owner-${suffix}`;
    await database.db.insert(profileTable).values([
      {
        account: memberAccount,
        domain: 'local',
        namespaceId: 0,
        profileRev: 7,
        displayName: 'Seven',
      },
      {
        account: memberAccount,
        domain: 'local',
        namespaceId: 0,
        profileRev: 4,
        displayName: 'Four',
      },
    ]);
    const [initial] = await database.db
      .select({ metaEndId: groupMeta.metaEndId })
      .from(groupMeta)
      .where(eq(groupMeta.threadId, groupId));
    const firstId = initial.metaEndId + 1;
    const commitMessage = (seq: number, profileRev: number) =>
      database.db.insert(message).values({
        threadId: groupId,
        seq,
        creatorAccount: memberAccount,
        creatorDomain: 'local',
        profileNamespaceId: 0,
        profileRev,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: `message ${seq}` }),
        updatedAt: new Date(),
      });
    const publish = (messageSeq: number, profileRev: number) =>
      database.db.transaction(async (tx) => {
        await lockBusinessAccountsInTx(tx, [
          { account: `!roster-${suffix}`, domain: 'local' },
        ]);
        const threadLock = await requireThreadContentLockInTx(tx, groupId);
        return publishMemberMessageProfileInTx(tx, {
          threadLock,
          account: memberAccount,
          domain: 'local',
          namespaceId: 0,
          messageSeq,
          profileRev,
        });
      });
    const selected = () =>
      database.db.query.groupMetaMemberFeed.findFirst({
        where: and(
          eq(groupMetaMemberFeed.threadId, groupId),
          eq(groupMetaMemberFeed.memberAccount, memberAccount),
        ),
      });
    await commitMessage(1, 7);
    expect(await publish(1, 7)).toBe(true);
    expect(await selected()).toMatchObject({
      feedId: firstId,
      profileSourceSeq: 1,
      body: { role: GroupRole.OWNER, profileRev: 7 },
    });
    await commitMessage(2, 7);
    expect(await publish(2, 7)).toBe(false);
    await commitMessage(3, 4);
    expect(await publish(3, 7)).toBe(false); // The message carries rev 4.
    expect(await publish(3, 4)).toBe(true); // Rev magnitude does not order messages.
    expect(await selected()).toMatchObject({
      feedId: firstId + 1,
      profileSourceSeq: 3,
      body: { role: GroupRole.OWNER, profileRev: 4 },
    });
    await commitMessage(4, 9);
    expect(await publish(4, 9)).toBe(false); // The exact snapshot is missing.
    await commitMessage(5, 0);
    expect(await publish(4, 9)).toBe(false); // A later message supersedes it.
    expect(await publish(5, 0)).toBe(true); // Zero requires no snapshot.
    expect(await selected()).toMatchObject({
      feedId: firstId + 2,
      profileSourceSeq: 5,
      body: { role: GroupRole.OWNER, profileRev: 0 },
    });

    // An old committed message can finish an async fetch after a new join;
    // its source coordinate belongs to the previous membership interval.
    await database.db.transaction(async (tx) => {
      await lockBusinessAccountsInTx(tx, [
        { account: `!roster-${suffix}`, domain: 'local' },
      ]);
      await requireThreadContentLockInTx(tx, groupId);
      const meta = new GroupMetaFeedService();
      await meta.appendMemberTransitionInTx(tx, groupId, {
        account: memberAccount,
        domain: 'local',
        operation: 'MEMBER_DEPART',
        body: {},
      });
      await meta.appendMemberTransitionInTx(tx, groupId, {
        account: memberAccount,
        domain: 'local',
        operation: 'MEMBER_UPSERT',
        body: { role: GroupRole.OWNER, profileRev: 1 },
      });
      await tx.insert(message).values({
        threadId: groupId,
        seq: 6,
        contentType: 'SYSTEM',
        creatorAccount: '$system',
        creatorDomain: 'local',
        profileRev: 0,
        content: JSON.stringify({
          type: 'GROUP_JOINED',
          member: {
            account: memberAccount,
            domain: 'local',
            namespaceId: 0,
            profileRev: 1,
          },
        }),
        updatedAt: new Date(),
      });
    });
    expect(await publish(5, 0)).toBe(false);
    expect(await selected()).toMatchObject({
      feedId: firstId + 4,
      profileSourceSeq: null,
      body: { role: GroupRole.OWNER, profileRev: 1 },
    });
    await commitMessage(7, 7);
    expect(await publish(7, 7)).toBe(true);
    expect(await selected()).toMatchObject({
      feedId: firstId + 5,
      profileSourceSeq: 7,
      body: { role: GroupRole.OWNER, profileRev: 7 },
    });
  });

  it('selects a remote member only after their exact home snapshot is stored', async () => {
    const domain = `roster-member-${suffix}.test`;
    const account = `remote-${suffix}`;
    const namespaceId = await seedFederatedPeerNamespace(database.db, domain);
    const [pair] = await database.db
      .insert(relationshipPair)
      .values({
        kind: 'GROUP_MEMBER',
        threadId: groupId,
        endpointAType: 'GROUP',
        endpointAAccount: `!roster-${suffix}`,
        endpointBAccount: account,
        endpointBNamespaceId: namespaceId,
        active: true,
        established: true,
      })
      .returning({ id: relationshipPair.id });
    remotePairId = pair.id;
    await database.db.transaction((tx) =>
      new GroupMetaFeedService().appendMemberTransitionInTx(tx, groupId, {
        account,
        domain,
        operation: 'MEMBER_UPSERT',
        body: { role: GroupRole.MEMBER, profileRev: 2 },
      }),
    );
    await database.db.insert(message).values({
      threadId: groupId,
      seq: 8,
      creatorAccount: account,
      creatorDomain: domain,
      profileNamespaceId: namespaceId,
      profileRev: 4,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: 'remote member' }),
      updatedAt: new Date(),
    });
    const publish = (messageSeq = 8) =>
      database.db.transaction(async (tx) => {
        await lockBusinessAccountsInTx(tx, [
          { account: `!roster-${suffix}`, domain: 'local' },
        ]);
        const threadLock = await requireThreadContentLockInTx(tx, groupId);
        return publishMemberMessageProfileInTx(tx, {
          threadLock,
          account,
          domain,
          namespaceId,
          messageSeq,
          profileRev: 4,
        });
      });
    expect(await publish()).toBe(false);
    await database.db.insert(profileTable).values({
      account,
      domain,
      namespaceId,
      profileRev: 4,
      displayName: 'Remote member',
    });
    await database.db
      .update(relationshipPair)
      .set({ active: false })
      .where(eq(relationshipPair.id, remotePairId));
    expect(await publish()).toBe(false); // Revocation fences post-fetch work.
    await database.db
      .update(relationshipPair)
      .set({ active: true })
      .where(eq(relationshipPair.id, remotePairId));
    await database.db.insert(message).values({
      threadId: groupId,
      seq: 9,
      contentType: 'SYSTEM',
      creatorAccount: '$system',
      creatorDomain: 'local',
      profileRev: 0,
      content: JSON.stringify({
        type: 'GROUP_JOINED',
        member: {
          account,
          domain,
          namespaceId,
          profileRev: 4,
        },
      }),
      updatedAt: new Date(),
    });
    expect(await publish()).toBe(false); // Prior membership cannot leak forward.
    await database.db.insert(message).values({
      threadId: groupId,
      seq: 10,
      creatorAccount: account,
      creatorDomain: domain,
      profileNamespaceId: namespaceId,
      profileRev: 4,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: 'new membership' }),
      updatedAt: new Date(),
    });
    expect(await publish(10)).toBe(true);
    const [fact] = await database.db
      .select({
        profileSourceSeq: groupMetaMemberFeed.profileSourceSeq,
        body: groupMetaMemberFeed.body,
      })
      .from(groupMetaMemberFeed)
      .where(
        and(
          eq(groupMetaMemberFeed.threadId, groupId),
          eq(groupMetaMemberFeed.memberAccount, account),
          eq(groupMetaMemberFeed.memberDomain, domain),
        ),
      );
    expect(fact).toMatchObject({
      profileSourceSeq: 10,
      body: { role: GroupRole.MEMBER, profileRev: 4 },
    });
  });
});
