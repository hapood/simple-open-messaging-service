import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  accountThreadState,
  groupAccount,
  groupMeta,
  messageThread,
  profileTable,
} from '../src/database/schema.js';
import { GroupService } from '../src/group/group.service.js';
import { ContactCardProfileService } from '../src/message/contact-card/contact-card-profile.service.js';
import { groupState, readGroupState } from '../src/group/shared/group-state.js';
import { GroupMetaFeedService } from '../src/group/meta/group-meta-feed.service.js';
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
    owner = await seedUser(app, 'profile-owner');
  });
  afterAll(async () => app.close());

  it('resolves contact-card groups only by a member-visible address', async () => {
    const created = await groups.createNewGroup({
      owner: owner.id,
      name: 'Visible group',
    });
    const state = await readGroupState(
      database.db,
      eq(groupState.id, created.threadId),
    );
    const address = {
      account: state!.account,
      namespaceId: state!.namespaceId,
    };
    expect(
      await groups.findVisibleGroupByAddress(owner.id, address),
    ).toMatchObject({
      id: created.threadId,
      account: state!.account,
    });
    const outsider = await seedUser(app, 'profile-outsider');
    expect(
      await groups.findVisibleGroupByAddress(outsider.id, address),
    ).toBeNull();
    await database.db
      .update(accountThreadState)
      .set({ messageVisibleThroughSeq: 0 })
      .where(
        and(
          eq(accountThreadState.accountId, owner.id),
          eq(accountThreadState.threadId, created.threadId),
        ),
      );
    expect(
      await groups.findVisibleGroupByAddress(owner.id, address),
    ).toBeNull();
  });

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
          eq(profileTable.profileNamespaceId, 0),
        ),
      )
      .orderBy(profileTable.profileRev);
    expect(versions.map((row) => row.profileRev)).toEqual([1, 2, 3]);
    expect(versions[0]).toMatchObject({ displayName: 'Original', bio: '' });
    expect(
      await app.get(ContactCardProfileService).findProfile({
        account: state!.account,
        namespaceId: 0,
        profileRev: 1,
      }),
    ).toMatchObject({ displayName: 'Original' });
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
      publisherNamespaceId: namespaceId,
      profileNamespaceId: namespaceId,
      profileRev: 2,
      displayName: 'Received name',
    });
    await database.db
      .insert(groupMeta)
      .values({ threadId: thread.id, metaEndId: 1, profileRev: 2 });
    expect(
      await readGroupState(database.db, eq(groupState.id, thread.id)),
    ).toMatchObject({ name: 'Received name', profileRev: 2, namespaceId });
    const contactProfiles = app.get(ContactCardProfileService);
    expect(
      await contactProfiles.findProfile({
        account: address,
        namespaceId,
        profileRev: 2,
      }),
    ).toMatchObject({ displayName: 'Received name' });
    expect(
      await contactProfiles.findProfile({
        account: address,
        namespaceId,
        profileRev: 0,
      }),
    ).toBeNull();
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
