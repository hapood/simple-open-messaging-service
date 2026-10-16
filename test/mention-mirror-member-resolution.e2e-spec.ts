import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { ThreadFeedHeadWriter } from '../src/message/thread-feed-head.writer.js';
import { ThreadFeedService } from '../src/message/thread-feed.service.js';
import { GroupService } from '../src/group/group.service.js';
import { GroupRole } from '../src/database/enums.js';
import {
  accountThreadState,
  groupAccount,
  groupMetaMemberFeed,
  identityNamespace,
  messageThread,
  message,
  profileTable,
  relationshipPair,
  account as user,
} from '../src/database/schema.js';
import { BusinessException } from '../src/common/business.exception.js';
import { BusinessCode } from '../src/common/business-code.js';
import { withMessageDigest } from './support/message-fixture.js';
import { seedFederatedPeerNamespace } from './seed.js';

describe('mention target resolution across group authority modes', () => {
  const suffix = Date.now().toString(36);
  let module: TestingModule;
  let database: DatabaseService;
  let groups: GroupService;
  let peerNamespaceId: number;
  let mirrorThreadId: number;
  let authorityThreadId: number;
  let authorityGroupId: number;
  let senderId: number;
  const createdUserIds: number[] = [];
  const createdPairIds: bigint[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = module.get(DatabaseService);
    groups = new GroupService(
      database,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    peerNamespaceId = await seedFederatedPeerNamespace(
      database.db,
      `mirror-mention-${suffix}.test`,
    );

    const [sender] = await database.db
      .insert(user)
      .values({
        account: `mirror-sender-${suffix}`,
        namespaceId: 0,
        updatedAt: new Date(),
      })
      .returning({ id: user.id });
    senderId = sender.id;
    createdUserIds.push(senderId);

    const [mirrorThread] = await database.db
      .insert(messageThread)
      .values({
        type: 'GROUP',
        groupAccount: `!mirror-mention-${suffix}`,
        groupDomain: `mirror-mention-${suffix}.test`,
        authorityNamespaceId: peerNamespaceId,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    mirrorThreadId = mirrorThread.id;
    const [authorityGroup] = await database.db
      .insert(groupAccount)
      .values({
        account: `!authority-mention-${suffix}`,
        updatedAt: new Date(),
      })
      .returning({ id: groupAccount.id });
    authorityGroupId = authorityGroup.id;
    const [authorityThread] = await database.db
      .insert(messageThread)
      .values({
        type: 'GROUP',
        groupAccount: `!authority-mention-${suffix}`,
        groupDomain: 'local',
        groupAccountId: authorityGroup.id,
        authorityNamespaceId: 0,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    authorityThreadId = authorityThread.id;

    // The mirror sender is the only local member with a materialized pair.
    const [senderPair] = await database.db
      .insert(relationshipPair)
      .values({
        kind: 'GROUP_MEMBER',
        threadId: mirrorThreadId,
        endpointAType: 'USER',
        endpointAAccount: `mirror-sender-${suffix}`,
        endpointANamespaceId: 0,
        endpointBType: 'GROUP',
        endpointBAccount: `!mirror-mention-${suffix}`,
        endpointBNamespaceId: peerNamespaceId,
        active: true,
        established: true,
      })
      .returning({ id: relationshipPair.id });
    createdPairIds.push(senderPair.id);

    await database.db.insert(accountThreadState).values({
      accountId: senderId,
      threadId: mirrorThreadId,
      updatedAt: new Date(),
    });

    await database.db.insert(profileTable).values([
      {
        publisherNamespaceId: peerNamespaceId,
        profileNamespaceId: 0,
        account: `peer-owner-${suffix}`,
        profileRev: 1,
        displayName: 'Peer Owner',
        updatedAt: new Date(),
      },
      {
        publisherNamespaceId: peerNamespaceId,
        profileNamespaceId: 1,
        account: `peer-member-${suffix}`,
        profileRev: 1,
        displayName: 'Peer Member',
        updatedAt: new Date(),
      },
      {
        publisherNamespaceId: 1,
        profileNamespaceId: 0,
        account: `authority-pairless-${suffix}`,
        profileRev: 1,
        displayName: 'Authority Pairless',
        updatedAt: new Date(),
      },
    ]);

    await database.db.insert(groupMetaMemberFeed).values([
      {
        threadId: mirrorThreadId,
        feedId: 1,
        operation: 'MEMBER_UPSERT',
        body: {
          account: `peer-owner-${suffix}`,
          namespaceId: 0,
          role: GroupRole.OWNER,
          profileRev: 1,
        },
      },
      {
        threadId: mirrorThreadId,
        feedId: 2,
        operation: 'MEMBER_UPSERT',
        body: {
          account: `peer-member-${suffix}`,
          namespaceId: 1,
          role: GroupRole.MEMBER,
          profileRev: 1,
        },
      },
      {
        threadId: mirrorThreadId,
        feedId: 3,
        operation: 'MEMBER_DEPART',
        body: {
          account: `peer-departed-${suffix}`,
          namespaceId: 2,
          role: GroupRole.MEMBER,
          profileRev: 1,
        },
      },
      {
        threadId: authorityThreadId,
        feedId: 1,
        operation: 'MEMBER_UPSERT',
        body: {
          account: `authority-pairless-${suffix}`,
          namespaceId: 0,
          role: GroupRole.MEMBER,
          profileRev: 1,
        },
      },
    ]);
  });

  afterAll(async () => {
    await database.db
      .delete(profileTable)
      .where(
        inArray(profileTable.account, [
          `peer-owner-${suffix}`,
          `peer-member-${suffix}`,
          `authority-pairless-${suffix}`,
        ]),
      );
    await database.db
      .delete(groupMetaMemberFeed)
      .where(
        inArray(groupMetaMemberFeed.threadId, [
          mirrorThreadId,
          authorityThreadId,
        ]),
      );
    await database.db
      .delete(accountThreadState)
      .where(eq(accountThreadState.threadId, mirrorThreadId));
    await database.db
      .delete(relationshipPair)
      .where(inArray(relationshipPair.id, createdPairIds));
    await database.db
      .delete(messageThread)
      .where(inArray(messageThread.id, [mirrorThreadId, authorityThreadId]));
    await database.db
      .delete(groupAccount)
      .where(eq(groupAccount.id, authorityGroupId));
    await database.db.delete(user).where(inArray(user.id, createdUserIds));
    await database.db
      .delete(identityNamespace)
      .where(eq(identityNamespace.id, peerNamespaceId));
    await module.close();
  });

  it.each([12, null])(
    'projects the viewer in the group origin namespace (assigned=%s)',
    async (assigned) => {
      await database.db
        .update(identityNamespace)
        .set({ peerAssignedLocalNamespaceId: assigned })
        .where(eq(identityNamespace.id, peerNamespaceId));
      await database.db.transaction(async (tx) => {
        const state = await ThreadFeedHeadWriter.readStateInTx(
          tx,
          senderId,
          mirrorThreadId,
        );
        expect(state.selfMentionNamespaceId).toBe(assigned);
      });
      const feed = await new ThreadFeedService(database).queryThreadFeedDelta(
        senderId,
        { after: 0 },
      );
      expect(
        feed.items.find((item) => item.threadId === mirrorThreadId)
          ?.selfMentionNamespaceId,
      ).toBe(assigned);
    },
  );

  it('does not badge a mirrored viewer for a same-account mention in another origin namespace', async () => {
    await database.db.transaction(async (tx) => {
      await tx
        .update(identityNamespace)
        .set({ peerAssignedLocalNamespaceId: 12 })
        .where(eq(identityNamespace.id, peerNamespaceId));
      const selfAccount = `mirror-sender-${suffix}`;
      await tx.insert(message).values(
        [12, 15].map((namespaceId, index) =>
          withMessageDigest({
            threadId: mirrorThreadId,
            seq: index + 1,
            publisherNamespaceId: peerNamespaceId,
            profileNamespaceId: 0,
            creatorAccount: `peer-owner-${suffix}`,
            originSeq: index + 1,
            contentType: 'PURE_TEXT',
            content: JSON.stringify({
              text: `[@Sender](somfp://user/${namespaceId}/${selfAccount})`,
            }),
            updatedAt: new Date(),
          }),
        ),
      );
      const previous = await ThreadFeedHeadWriter.readStateInTx(
        tx,
        senderId,
        mirrorThreadId,
      );
      expect(
        await ThreadFeedHeadWriter.resolveMentionInTx(
          tx,
          senderId,
          mirrorThreadId,
          previous,
          { lastReadSeq: 0, messageEndSeq: 2, tombstoneEndSeq: 0 },
        ),
      ).toBe(1);
      await tx.delete(message).where(eq(message.threadId, mirrorThreadId));
    });
  });

  it('uses namespace zero only for viewers of a locally authoritative group', async () => {
    await database.db.transaction(async (tx) => {
      await tx
        .insert(accountThreadState)
        .values({
          accountId: senderId,
          threadId: authorityThreadId,
          updatedAt: new Date(),
        });
      const state = await ThreadFeedHeadWriter.readStateInTx(
        tx,
        senderId,
        authorityThreadId,
      );
      expect(state.selfMentionNamespaceId).toBe(0);
      await tx
        .delete(accountThreadState)
        .where(eq(accountThreadState.threadId, authorityThreadId));
    });
  });

  it('resolves non-local members on a member-home mirror from the Group Meta roster', async () => {
    const resolved = await groups.resolveActiveMember(mirrorThreadId, {
      account: `peer-member-${suffix}`,
      namespaceId: 1,
    });
    expect(resolved).toMatchObject({
      account: `peer-member-${suffix}`,
      namespaceId: 1,
      name: 'Peer Member',
    });
    const originLocal = await groups.resolveActiveMember(mirrorThreadId, {
      account: `peer-owner-${suffix}`,
      namespaceId: 0,
    });
    expect(originLocal).toMatchObject({
      account: `peer-owner-${suffix}`,
      namespaceId: 0,
      name: 'Peer Owner',
    });
  });

  it('still rejects departed members on a mirror', async () => {
    await expect(
      groups.resolveActiveMember(mirrorThreadId, {
        account: `peer-departed-${suffix}`,
        namespaceId: 2,
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.GROUP_TARGET_NOT_MEMBER,
    });
  });

  it('keeps the RelationshipPair requirement on authoritative groups', async () => {
    await expect(
      groups.resolveActiveMember(authorityThreadId, {
        account: `authority-pairless-${suffix}`,
        namespaceId: 0,
      }),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('keeps rejecting unknown members on a mirror', async () => {
    await expect(
      groups.resolveActiveMember(mirrorThreadId, {
        account: `unknown-${suffix}`,
        namespaceId: 0,
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.GROUP_TARGET_NOT_MEMBER,
    });
  });
});
