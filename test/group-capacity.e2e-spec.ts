import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, count, eq, isNull } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { GroupRole, MessageThreadType } from '../src/database/enums.js';
import {
  group,
  messageThread,
  threadParticipant,
  user,
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
          name: `capacity ${index}`,
          domain: 'local',
          isForeigner: false,
          updatedAt: new Date(),
        })),
      )
      .returning({ id: user.id });
    const [groupUser] = await database.db
      .insert(user)
      .values({
        account: `!cap${suffix}`,
        name: 'capacity group',
        domain: 'local',
        isForeigner: false,
        isGroup: true,
        hashPwd: '',
        updatedAt: new Date(),
      })
      .returning({ id: user.id });
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: MessageThreadType.GROUP,
        groupUserId: groupUser.id,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    await database.db.insert(group).values({
      groupUserId: groupUser.id,
      ownerId: people[0].id,
      updatedAt: new Date(),
    });
    await database.db.insert(threadParticipant).values(
      people.slice(0, SERVER_MAX_GROUP_MEMBERS - 1).map((person, index) => ({
        threadId: thread.id,
        userId: person.id,
        role: index === 0 ? GroupRole.OWNER : GroupRole.MEMBER,
        updatedAt: new Date(),
      })),
    );

    const join = (userId: number) =>
      database.db.transaction(async (tx) => {
        await assertServerGroupCapacityInTx(tx, thread.id, userId);
        await tx.insert(threadParticipant).values({
          threadId: thread.id,
          userId,
          role: GroupRole.MEMBER,
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
      .from(threadParticipant)
      .where(
        and(
          eq(threadParticipant.threadId, thread.id),
          isNull(threadParticipant.leftAt),
        ),
      );
    expect(value).toBe(SERVER_MAX_GROUP_MEMBERS);

    const admitted = await database.db.query.threadParticipant.findFirst({
      where: and(
        eq(threadParticipant.threadId, thread.id),
        isNull(threadParticipant.leftAt),
      ),
      columns: { userId: true },
    });
    await expect(
      database.db.transaction((tx) =>
        assertServerGroupCapacityInTx(tx, thread.id, admitted!.userId),
      ),
    ).resolves.toBeUndefined();
  }, 30_000);
});
