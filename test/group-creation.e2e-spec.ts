import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { accountThreadState, message } from '../src/database/schema.js';
import { readThreadHeadSnapshotInTx } from '../src/federation/federation-thread-head-snapshot.js';
import { GroupService } from '../src/group/group.service.js';
import { seedUser } from './seed.js';

describe('group creation', () => {
  let app: TestingModule;
  let database: DatabaseService;
  let groups: GroupService;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = app.get(DatabaseService);
    groups = app.get(GroupService);
  });

  afterAll(async () => app.close());

  it('writes one authority-local creation message without advertising it to federation', async () => {
    const owner = await seedUser(
      app as unknown as INestApplication,
      'group-creation-owner',
    );
    const created = await groups.createNewGroup({
      owner: owner.id,
      name: 'Created group',
    });

    const creation = await database.db.query.message.findFirst({
      where: and(
        eq(message.threadId, created.threadId),
        eq(message.contentType, 'SYSTEM'),
      ),
    });
    expect(creation).toMatchObject({
      seq: 1,
      creatorAccount: '$system',
      creatorDomain: 'local',
    });
    expect(JSON.parse(creation!.content)).toEqual({
      type: 'GROUP_CREATED',
      creator: { account: owner.account, domain: 'local' },
    });
    expect(
      await database.db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.accountId, owner.id),
          eq(accountThreadState.threadId, created.threadId),
        ),
      }),
    ).toMatchObject({ lastReadSeq: 1, unreadCount: 0 });
    expect(
      await database.db.transaction((tx) =>
        readThreadHeadSnapshotInTx(tx, created.threadId),
      ),
    ).toEqual({ messageEndSeq: 0, tombstoneEndSeq: 0 });
  });
});
