import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { GroupRole, MessageThreadType } from '../src/database/enums.js';
import {
  group,
  messageThread,
  threadMember,
  user,
} from '../src/database/schema.js';
import type { DatabaseTransaction } from '../src/database/database.service.js';
import type { GroupMetaFeedPage } from '../src/federation/group-meta-feed.service.js';
import { FederationService } from '../src/federation/federation.service.js';
import { recordHostedGroupSentBoundaries } from '../src/message/hosted-group-sent-boundaries.js';

describe('federation Group Meta consumer', () => {
  const suffix = Date.now().toString(36);
  const peerDomain = `group-meta-source-${suffix}.test`;
  const groupAccount = `!mirror${suffix}`;
  let mod: TestingModule;
  let database: DatabaseService;
  let groupId: number;
  let threadId: number;
  let ownerId: number;
  let memberId: number;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
    const users = await database.db
      .insert(user)
      .values([
        {
          account: `owner-${suffix}`,
          domain: peerDomain,
          sourceDomain: peerDomain,
          name: 'Owner',
          profileRev: 1,
          updatedAt: new Date(),
        },
        {
          account: `member-${suffix}`,
          domain: 'member.example',
          sourceDomain: peerDomain,
          name: 'Old member',
          profileRev: 1,
          updatedAt: new Date(),
        },
      ])
      .returning({ id: user.id });
    [ownerId, memberId] = users.map((row) => row.id);
    const [createdGroup] = await database.db
      .insert(group)
      .values({
        account: groupAccount,
        domain: peerDomain,
        name: 'Mirror',
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
        userId: ownerId,
        role: GroupRole.OWNER,
        left: false,
        updatedAt: new Date(),
      },
      {
        threadId,
        userId: memberId,
        role: GroupRole.MEMBER,
        left: false,
        updatedAt: new Date(),
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
    await database.db.delete(user).where(inArray(user.id, [ownerId, memberId]));
    await mod.close();
  });

  it('retains the complete DEPART member for historical message display', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    const applyProjection = vi.fn().mockResolvedValue({
      threadId,
      users: [],
      statePushDomains: [],
      systemMessages: [],
    });
    Object.assign(service, {
      config: { domain: 'consumer.test' },
      upload: { saveAvatarFromWire: vi.fn() },
      groupRosterProjection: { applyInTx: applyProjection },
    });
    const page: GroupMetaFeedPage = {
      account: groupAccount,
      mode: 'delta',
      items: [
        {
          feedId: '2',
          account: `member-${suffix}`,
          domain: 'member.example',
          operation: 'DEPART',
          body: {
            role: GroupRole.ADMIN,
            profileRev: 4,
            displayName: 'Historical member',
            avatar: null,
          },
        },
      ],
      scannedThrough: '2',
      groupMetaFeedEndId: '2',
      hasMore: false,
    };
    const target = service as unknown as {
      applyGroupMetaFeedPageInTx(
        tx: DatabaseTransaction,
        peer: string,
        account: string,
        page: GroupMetaFeedPage,
      ): Promise<unknown>;
    };

    await database.db.transaction((tx) =>
      target.applyGroupMetaFeedPageInTx(tx, peerDomain, groupAccount, page),
    );

    const retained = await database.db
      .select({
        left: threadMember.left,
        role: threadMember.role,
        name: user.name,
        profileRev: user.profileRev,
        sourceDomain: user.sourceDomain,
      })
      .from(threadMember)
      .innerJoin(user, eq(user.id, threadMember.userId))
      .where(
        and(
          eq(threadMember.threadId, threadId),
          eq(threadMember.userId, memberId),
        ),
      );
    expect(retained).toEqual([
      {
        left: true,
        role: GroupRole.ADMIN,
        name: 'Historical member',
        profileRev: 4,
        sourceDomain: peerDomain,
      },
    ]);
    expect(applyProjection).toHaveBeenCalledOnce();
  });

  it('does not write hosted sent boundaries on a federation mirror', async () => {
    await database.db.transaction((tx) =>
      recordHostedGroupSentBoundaries(
        tx,
        threadId,
        { account: `member-${suffix}`, domain: 'member.example' },
        7,
      ),
    );
    const mirrored = await database.db.query.threadMember.findFirst({
      where: and(
        eq(threadMember.threadId, threadId),
        eq(threadMember.userId, memberId),
      ),
      columns: { firstSentSeq: true, lastSentSeq: true },
    });
    expect(mirrored).toEqual({ firstSentSeq: null, lastSentSeq: null });
  });
});
