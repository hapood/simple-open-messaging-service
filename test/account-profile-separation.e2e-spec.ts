import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  groupAccount,
  groupMeta,
  messageThread,
  profileTable,
} from '../src/database/schema.js';
import { GroupService } from '../src/business/group/group.service.js';
import {
  groupState,
  readGroupState,
} from '../src/business/group/shared/group-state.js';
import { GroupMetaFeedService } from '../src/business/group/meta/group-meta-feed.service.js';
import { seedFederatedPeerNamespace, seedUser } from './seed.js';

describe('account controls and exact profiles', () => {
  let app: TestingModule;
  let database: DatabaseService;
  let groups: GroupService;
  let owner: { id: number; account: string };
  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = app.get(DatabaseService);
    groups = app.get(GroupService);
    owner = await seedUser(app as unknown as INestApplication, 'profile-owner');
  });
  afterAll(async () => app.close());

  it('has no User or Group table and keeps local credentials separate from display', async () => {
    const result = await database.db.execute(
      sql`SELECT to_regclass('public."User"') AS "oldUser", to_regclass('public."Group"') AS "oldGroup"`,
    );
    expect(result.rows[0]).toEqual({ oldUser: null, oldGroup: null });
    const local = await database.db.query.account.findFirst({
      where: eq(account.id, owner.id),
    });
    expect(local).toMatchObject({
      account: owner.account,
      domain: 'local',
      namespaceId: 0,
      defaultProfileRev: 1,
    });
    expect(local).not.toHaveProperty('name');
    expect(
      await database.db.query.profileTable.findFirst({
        where: eq(profileTable.account, owner.account),
      }),
    ).toMatchObject({ displayName: owner.account, profileRev: 1 });
  });

  it('serializes concurrent group profile changes and retains immutable older versions', async () => {
    const created = await groups.createNewGroup({
      owner: owner.id,
      name: 'Original',
    });
    await Promise.all([
      groups.updateGroup({
        threadId: created.threadId,
        operatorUserId: owner.id,
        name: 'Renamed',
      }),
      groups.updateGroup({
        threadId: created.threadId,
        operatorUserId: owner.id,
        description: 'Updated bio',
      }),
    ]);
    const state = await readGroupState(
      database.db,
      eq(groupState.id, created.threadId),
    );
    expect(state).toMatchObject({
      name: 'Renamed',
      description: 'Updated bio',
      profileRev: 3,
    });
    const versions = await database.db
      .select()
      .from(profileTable)
      .where(
        and(
          eq(profileTable.account, state!.account),
          eq(profileTable.namespaceId, 0),
        ),
      )
      .orderBy(profileTable.profileRev);
    expect(versions.map((row) => row.profileRev)).toEqual([1, 2, 3]);
    expect(versions[0]).toMatchObject({ displayName: 'Original', bio: '' });
    expect(
      await database.db.query.groupAccount.findFirst({
        where: eq(groupAccount.account, state!.account),
      }),
    ).toMatchObject({ defaultProfileRev: 3 });
  });

  it('rolls back the new profile and authoring pointer if metadata publication fails', async () => {
    const created = await groups.createNewGroup({
      owner: owner.id,
      name: 'Before rollback',
    });
    const before = await readGroupState(
      database.db,
      eq(groupState.id, created.threadId),
    );
    const publish = vi
      .spyOn(app.get(GroupMetaFeedService), 'reconcileProfileInTx')
      .mockRejectedValueOnce(new Error('publication failed'));
    try {
      await expect(
        groups.updateGroup({
          threadId: created.threadId,
          operatorUserId: owner.id,
          name: 'Must roll back',
        }),
      ).rejects.toThrow('publication failed');
    } finally {
      publish.mockRestore();
    }
    expect(
      await readGroupState(database.db, eq(groupState.id, created.threadId)),
    ).toMatchObject({ name: 'Before rollback', profileRev: 1 });
    expect(
      await database.db
        .select()
        .from(profileTable)
        .where(eq(profileTable.account, before!.account)),
    ).toHaveLength(1);
  });

  it('reads a mirror profile directly from received metadata without a second committed-version pointer', async () => {
    const namespaceId = await seedFederatedPeerNamespace(
      database.db,
      'profile-origin.test',
    );
    const address = '!mirrorprofile';
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'GROUP',
        groupAccount: address,
        groupDomain: 'profile-origin.test',
        authorityNamespaceId: namespaceId,
        updatedAt: new Date(),
      })
      .returning();
    await database.db.insert(profileTable).values({
      account: address,
      domain: 'profile-origin.test',
      namespaceId,
      profileRev: 2,
      displayName: 'Received name',
    });
    await database.db
      .insert(groupMeta)
      .values({ threadId: thread.id, metaEndId: 1n, profileRev: 2 });
    expect(
      await readGroupState(database.db, eq(groupState.id, thread.id)),
    ).toMatchObject({ name: 'Received name', profileRev: 2, namespaceId });
    expect(
      await database.db.query.groupAccount.findFirst({
        where: eq(groupAccount.account, address),
      }),
    ).toBeUndefined();
    expect(
      await database.db.query.account.findFirst({
        where: eq(account.account, address),
      }),
    ).toBeUndefined();
  });
});
