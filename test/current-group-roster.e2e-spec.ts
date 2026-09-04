import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { inArray } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { GroupRole } from '../src/database/enums.js';
import { group, groupMetaMemberFeed, user } from '../src/database/schema.js';
import { readCurrentGroupRosterInTx } from '../src/group-meta/current-group-roster.js';

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
          name: 'Owner',
          updatedAt: new Date(),
        },
        {
          account: `departed-${suffix}`,
          domain: 'local',
          namespaceId: 0,
          name: 'Departed',
          updatedAt: new Date(),
        },
      ])
      .returning({ id: user.id });
    userIds = identities.map((identity) => identity.id);
    const [createdGroup] = await database.db
      .insert(group)
      .values({
        account: `!roster-${suffix}`,
        domain: 'local',
        namespaceId: 0,
        name: 'Roster',
        updatedAt: new Date(),
      })
      .returning({ id: group.id });
    groupId = createdGroup.id;
    await database.db.insert(groupMetaMemberFeed).values([
      {
        groupId,
        feedId: 1n,
        memberUserId: userIds[0]!,
        operation: 'UPSERT',
        body: { role: GroupRole.OWNER, profileRev: 1 },
      },
      {
        groupId,
        feedId: 2n,
        memberUserId: userIds[1]!,
        operation: 'UPSERT',
        body: { role: GroupRole.MEMBER, profileRev: 1 },
      },
      {
        groupId,
        feedId: 3n,
        memberUserId: userIds[1]!,
        operation: 'DEPART',
        body: {},
      },
    ]);
  });

  afterAll(async () => {
    await database.db.delete(group).where(inArray(group.id, [groupId]));
    await database.db.delete(user).where(inArray(user.id, userIds));
    await module.close();
  });

  it('selects only the newest active operation for each stable member', async () => {
    const roster = await database.db.transaction((tx) =>
      readCurrentGroupRosterInTx(tx, groupId),
    );

    expect(roster).toEqual([
      expect.objectContaining({
        userId: userIds[0],
        role: GroupRole.OWNER,
        profileRev: 1,
      }),
    ]);
  });
});
