import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federatedPeer,
  federationMessageFeedIndex,
  group,
  messageThread,
  threadAudience,
  threadMember,
  user,
} from '../src/database/schema.js';
import { MessageThreadType } from '../src/database/enums.js';
import { DepartedMemberProfileQueryService } from '../src/federation/departed-member-profile-query.service.js';
import { FederationMessageFeedService } from '../src/federation/federation-message-feed.service.js';
import { UploadService } from '../src/upload/upload.service.js';
import { recordHostedGroupSentBoundaries } from '../src/message/hosted-group-sent-boundaries.js';

describe('departed-member profile query', () => {
  const suffix = Date.now().toString(36);
  const peerDomain = `departed-profile-${suffix}.test`;
  const groupAccount = `!departed${suffix}`;
  const memberAccounts = [
    `first-${suffix}`,
    `last-${suffix}`,
    `bounds-${suffix}`,
  ];
  let mod: TestingModule;
  let database: DatabaseService;
  let service: DepartedMemberProfileQueryService;
  let groupId: number;
  let threadId: number;
  let memberIds: number[];

  beforeAll(async () => {
    const messageFeed = {
      resolveAuthorizedThread: async () => ({
        threadId,
        messageAccessAfterSeq: 10,
      }),
    };
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        DepartedMemberProfileQueryService,
        { provide: FederationMessageFeedService, useValue: messageFeed },
        {
          provide: UploadService,
          useValue: { readAvatarAsWire: async () => null },
        },
      ],
    }).compile();
    database = mod.get(DatabaseService);
    service = mod.get(DepartedMemberProfileQueryService);
    await database.db.insert(federatedPeer).values({ domain: peerDomain });
    const members = await database.db
      .insert(user)
      .values(
        memberAccounts.map((account, index) => ({
          account,
          domain: `member-${index}.example`,
          sourceDomain: 'local',
          name: `Member ${index}`,
          profileRev: index + 1,
          updatedAt: new Date(),
        })),
      )
      .returning({ id: user.id });
    memberIds = members.map(({ id }) => id);
    const [createdGroup] = await database.db
      .insert(group)
      .values({
        account: groupAccount,
        domain: 'local',
        name: 'Departed profiles',
        updatedAt: new Date(),
      })
      .returning({ id: group.id });
    groupId = createdGroup.id;
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: MessageThreadType.GROUP,
        groupId,
        curSeq: 50,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await database.db.insert(threadMember).values([
      {
        threadId,
        userId: memberIds[0],
        role: 'MEMBER',
        left: true,
        firstSentSeq: 20,
        lastSentSeq: 30,
        updatedAt: new Date(),
      },
      {
        threadId,
        userId: memberIds[1],
        role: 'MEMBER',
        left: true,
        firstSentSeq: 25,
        lastSentSeq: 45,
        updatedAt: new Date(),
      },
      {
        threadId,
        userId: memberIds[2],
        role: 'MEMBER',
        updatedAt: new Date(),
      },
    ]);
    await database.db.insert(threadAudience).values({
      targetDomain: peerDomain,
      threadId,
      messageAccessAfterSeq: 10,
    });
    await database.db.insert(federationMessageFeedIndex).values({
      peerDomain,
      threadId,
      feedId: 1n,
      messageEndSeq: 50,
    });
  });

  afterAll(async () => {
    await database.db
      .delete(federationMessageFeedIndex)
      .where(eq(federationMessageFeedIndex.peerDomain, peerDomain));
    await database.db
      .delete(threadAudience)
      .where(eq(threadAudience.threadId, threadId));
    await database.db
      .delete(threadMember)
      .where(eq(threadMember.threadId, threadId));
    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId));
    await database.db.delete(group).where(eq(group.id, groupId));
    await database.db.delete(user).where(inArray(user.id, memberIds));
    await database.db
      .delete(federatedPeer)
      .where(eq(federatedPeer.domain, peerDomain));
    await mod.close();
  });

  it('selects last-sent boundaries in reverse', async () => {
    const reverse = await service.query(peerDomain, groupAccount, 51, 1, 11);
    expect(reverse).toMatchObject({
      members: [{ account: memberAccounts[1], lastSentSeq: 45 }],
      scannedThrough: 45,
      hasMore: true,
    });
  });

  it('keeps the earliest and latest hosted-group sent boundaries', async () => {
    const author = { account: memberAccounts[2], domain: 'member-2.example' };
    await database.db.transaction(async (tx) => {
      await recordHostedGroupSentBoundaries(tx, threadId, author, 22);
      await recordHostedGroupSentBoundaries(tx, threadId, author, 40);
      await recordHostedGroupSentBoundaries(tx, threadId, author, 15);
    });
    const member = await database.db.query.threadMember.findFirst({
      where: and(
        eq(threadMember.threadId, threadId),
        eq(threadMember.userId, memberIds[2]),
      ),
      columns: { firstSentSeq: true, lastSentSeq: true },
    });
    expect(member).toMatchObject({ firstSentSeq: 15, lastSentSeq: 40 });
  });

  it('does not split members that share one compressed-feed sequence', async () => {
    const account = `tie-${suffix}`;
    const [tiedUser] = await database.db
      .insert(user)
      .values({
        account,
        domain: 'tie.example',
        sourceDomain: 'local',
        name: 'Tied member',
        profileRev: 1,
        updatedAt: new Date(),
      })
      .returning({ id: user.id });
    await database.db.insert(threadMember).values({
      threadId,
      userId: tiedUser.id,
      role: 'MEMBER',
      left: true,
      firstSentSeq: 20,
      lastSentSeq: 30,
      updatedAt: new Date(),
    });
    try {
      const page = await service.query(peerDomain, groupAccount, 31, 1, 11);
      expect(page.members.map((member) => member.account).sort()).toEqual(
        [memberAccounts[0], account].sort(),
      );
      expect(page).toMatchObject({
        scannedThrough: 11,
        hasMore: false,
      });
    } finally {
      await database.db
        .delete(threadMember)
        .where(eq(threadMember.userId, tiedUser.id));
      await database.db.delete(user).where(eq(user.id, tiedUser.id));
    }
  });

  it('omits a rejoined member and exposes the shared bootstrap window', async () => {
    await database.db
      .update(threadMember)
      .set({ left: false })
      .where(
        and(
          eq(threadMember.threadId, threadId),
          eq(threadMember.userId, memberIds[1]),
        ),
      );
    const page = await service.query(peerDomain, groupAccount, 51, 10, 11);
    expect(page.members.map(({ account }) => account)).toEqual([
      memberAccounts[0],
    ]);
    await expect(
      service.query(peerDomain, groupAccount, undefined),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      data: { resumeAfter: 10, resumeBefore: 51 },
    });
  });
});
