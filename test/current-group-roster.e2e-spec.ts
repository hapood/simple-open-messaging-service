import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { inArray } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { GroupRole } from '../src/database/enums.js';
import {
  groupAccount as group,
  messageThread,
  groupMetaMemberFeed,
  account as user,
} from '../src/database/schema.js';
import { readCurrentGroupRosterInTx } from '../src/group/meta/current-group-roster.js';

describe('current Group Meta roster', () => {
  const suffix = Date.now().toString(36);
  let module: TestingModule;
  let database: DatabaseService;
  let groupId: number;
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
    await database.db.insert(groupMetaMemberFeed).values([
      {
        threadId: groupId,
        feedId: 1n,
        memberAccount: `owner-${suffix}`,
        memberDomain: 'local',
        operation: 'UPSERT',
        body: { role: GroupRole.OWNER, profileRev: 1 },
      },
      {
        threadId: groupId,
        feedId: 3n,
        memberAccount: `departed-${suffix}`,
        memberDomain: 'local',
        operation: 'DEPART',
        body: {},
      },
    ]);
  });

  afterAll(async () => {
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
});
