import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  accountThreadState,
  groupMeta,
  groupMetaMemberFeed,
  message,
  profileTable,
  messageThread,
} from '../src/database/schema.js';
import { GroupRole } from '../src/database/enums.js';
import { readCurrentGroupRosterInTx } from '../src/group/meta/current-group-roster.js';
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

  it.each([30, 31])(
    'persists creation and rename at %i characters',
    async (length) => {
      const owner = await seedUser(
        app as unknown as INestApplication,
        `name-boundary-${length}`,
      );
      const created = await groups.createNewGroup({
        owner: owner.id,
        name: 'a'.repeat(length),
      });
      await groups.updateGroup({
        threadId: created.threadId,
        operatorUserId: owner.id,
        name: '界'.repeat(length),
      });
      const thread = await database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, created.threadId),
      });
      const profiles = await database.db
        .select()
        .from(profileTable)
        .where(eq(profileTable.account, thread!.groupAccount!));
      expect(profiles.map((profile) => profile.displayName).sort()).toEqual(
        ['a'.repeat(length), '界'.repeat(length)].sort(),
      );
      await expect(
        groups.updateGroup({
          threadId: created.threadId,
          operatorUserId: owner.id,
          name: 'a'.repeat(32),
        }),
      ).rejects.toMatchObject({
        bizCode: 10000,
        message: 'group name must be at most 31 characters',
      });
    },
  );

  it('rejects an over-limit creation before accessing the database', async () => {
    await expect(
      groups.createNewGroup({ owner: -1, name: 'a'.repeat(32) }),
    ).rejects.toMatchObject({
      bizCode: 10000,
      message: 'group name must be at most 31 characters',
    });
  });

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

  it('publishes the creator as the first OWNER in the authoritative Group Meta roster', async () => {
    const owner = await seedUser(
      app as unknown as INestApplication,
      'group-creation-roster-owner',
    );
    const created = await groups.createNewGroup({
      owner: owner.id,
      name: 'Roster group',
    });

    const [meta] = await database.db
      .select({ metaEndId: groupMeta.metaEndId })
      .from(groupMeta)
      .where(eq(groupMeta.threadId, created.threadId));
    const facts = await database.db
      .select({
        feedId: groupMetaMemberFeed.feedId,
        account: groupMetaMemberFeed.memberAccount,
        domain: groupMetaMemberFeed.memberDomain,
        operation: groupMetaMemberFeed.operation,
        body: groupMetaMemberFeed.body,
      })
      .from(groupMetaMemberFeed)
      .where(eq(groupMetaMemberFeed.threadId, created.threadId));

    expect(meta?.metaEndId).toBeGreaterThan(0);
    expect(facts).toEqual([
      expect.objectContaining({ operation: 'GROUP_PROFILE' }),
      expect.objectContaining({
        account: owner.account,
        domain: 'local',
        operation: 'UPSERT',
        body: { role: GroupRole.OWNER, profileRev: 1 },
      }),
    ]);
    expect(
      await database.db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.accountId, owner.id),
          eq(accountThreadState.threadId, created.threadId),
        ),
      }),
    ).toMatchObject({ groupMetaFeedEndId: meta?.metaEndId });
    await expect(
      database.db.transaction((tx) =>
        readCurrentGroupRosterInTx(tx, created.threadId),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        account: owner.account,
        domain: 'local',
        role: GroupRole.OWNER,
      }),
    ]);
  });
});
