import { lockBusinessAccountsInTx } from '../src/business/shared/locks/account-business-lock.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, count, eq } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { MessageThreadType } from '../src/database/enums.js';
import {
  account as accountTable,
  groupAccount as group,
  messageThread,
  relationshipIntent,
  relationshipPair,
  account as user,
} from '../src/database/schema.js';
import {
  assertServerGroupCapacityInTx,
  SERVER_MAX_GROUP_MEMBERS,
} from '../src/group/group-capacity.js';

describe('origin-server group capacity', () => {
  let mod: TestingModule;
  let database: DatabaseService;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });

  afterAll(async () => mod.close());

  it('serializes the final two joins and admits exactly the 999th member', async () => {
    const suffix = Date.now().toString(36);
    const people = await database.db
      .insert(user)
      .values(
        Array.from({ length: SERVER_MAX_GROUP_MEMBERS + 1 }, (_, index) => ({
          account: `cap-${suffix}-${index}`,
          domain: 'local',
          updatedAt: new Date(),
        })),
      )
      .returning({ id: user.id, account: user.account });
    const [groupProfile] = await database.db
      .insert(group)
      .values({
        account: `!cap${suffix}`,
        updatedAt: new Date(),
      })
      .returning({ id: group.id, account: group.account });
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: MessageThreadType.GROUP,
        groupAccount: groupProfile.account,
        groupDomain: 'local',
        groupAccountId: groupProfile.id,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    const authorizedPairs = await database.db
      .insert(relationshipPair)
      .values(
        people.slice(0, SERVER_MAX_GROUP_MEMBERS - 1).map((person) => ({
          kind: 'GROUP_MEMBER',
          endpointAType: 'GROUP',
          endpointAAccount: groupProfile.account,
          endpointADomain: 'local',
          endpointBType: 'USER',
          endpointBAccount: person.account,
          endpointBDomain: 'local',
          threadId: thread.id,
          active: true,
          updatedAt: new Date(),
        })),
      )
      .returning({ id: relationshipPair.id });
    await database.db.insert(relationshipIntent).values(
      authorizedPairs.map((pair) => ({
        pairId: pair.id,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        authorSide: 'A',
        status: 'ACCEPTED' as const,
        note: '',
        requestedAt: new Date(),
        expiresAt: null,
        updatedAt: new Date(),
      })),
    );

    const join = (userId: number) =>
      database.db.transaction(async (tx) => {
        await lockBusinessAccountsInTx(tx, [
          { account: groupProfile.account, domain: 'local' },
        ]);
        await assertServerGroupCapacityInTx(tx, thread.id, userId);
        const member = people.find((person) => person.id === userId)!;
        const [pair] = await tx
          .insert(relationshipPair)
          .values({
            kind: 'GROUP_MEMBER',
            endpointAType: 'GROUP',
            endpointAAccount: groupProfile.account,
            endpointADomain: 'local',
            endpointBType: 'USER',
            endpointBAccount: member.account,
            endpointBDomain: 'local',
            threadId: thread.id,
            active: true,
            updatedAt: new Date(),
          })
          .returning({ id: relationshipPair.id });
        await tx.insert(relationshipIntent).values({
          pairId: pair.id,
          messageEndSeq: 0,
          tombstoneEndSeq: 0,
          authorSide: 'A',
          status: 'ACCEPTED',
          note: '',
          requestedAt: new Date(),
          expiresAt: null,
          updatedAt: new Date(),
        });
      });
    const candidates = people.slice(-2);
    const results = await Promise.allSettled(
      candidates.map((candidate) => join(candidate.id)),
    );

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { bizCode: BusinessCode.GROUP_FULL },
    });
    const [{ value }] = await database.db
      .select({ value: count() })
      .from(relationshipIntent)
      .innerJoin(
        relationshipPair,
        eq(relationshipPair.id, relationshipIntent.pairId),
      )
      .where(
        and(
          eq(relationshipPair.endpointAType, 'GROUP'),
          eq(relationshipPair.endpointAAccount, groupProfile.account),
          eq(relationshipPair.endpointADomain, 'local'),
          eq(relationshipIntent.authorSide, 'A'),
          eq(relationshipIntent.status, 'ACCEPTED'),
        ),
      );
    expect(value).toBe(SERVER_MAX_GROUP_MEMBERS);

    const admitted =
      candidates[results.findIndex((result) => result.status === 'fulfilled')]!;
    await expect(
      database.db.transaction((tx) =>
        assertServerGroupCapacityInTx(tx, thread.id, admitted.id),
      ),
    ).resolves.toBeUndefined();
  }, 30_000);
});
