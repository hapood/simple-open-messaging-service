import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  groupAccount,
  groupMeta,
  groupMetaMemberFeed,
  identityNamespace,
  messageThread,
  profileTable,
  relationshipPair,
} from '../src/database/schema.js';
import { GroupMemberQueryService } from '../src/group/member-query/group-member-query.service.js';
import { seedFederatedPeerNamespace } from './seed.js';

describe('server group member queries', () => {
  let module: TestingModule;
  let database: DatabaseService;
  let service: GroupMemberQueryService;
  let userId: number;
  let outsiderId: number;
  let threadId: number;
  let peerId: number;
  let pairId: number;
  let localGroupAccountId: number;
  const self = 'query-self';

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [GroupMemberQueryService],
    }).compile();
    database = module.get(DatabaseService);
    service = module.get(GroupMemberQueryService);
    peerId = await seedFederatedPeerNamespace(database.db, 'member-query.test');
    await database.db
      .update(identityNamespace)
      .set({ peerAssignedLocalNamespaceId: 77 })
      .where(eq(identityNamespace.id, peerId));
    const [viewer, outsider] = await database.db
      .insert(account)
      .values([{ account: self }, { account: 'query-outsider' }])
      .returning();
    userId = viewer.id;
    outsiderId = outsider.id;
    const [control] = await database.db
      .insert(groupAccount)
      .values({ account: '!member-query' })
      .returning();
    localGroupAccountId = control.id;
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'GROUP',
        groupAccount: '!member-query',
        groupAccountId: control.id,
      })
      .returning();
    threadId = thread.id;
    const [pair] = await database.db
      .insert(relationshipPair)
      .values({
        kind: 'GROUP_MEMBER',
        endpointAType: 'GROUP',
        endpointAAccount: '!member-query',
        endpointANamespaceId: 0,
        endpointBType: 'USER',
        endpointBAccount: self,
        endpointBNamespaceId: 0,
        threadId,
        active: true,
        established: true,
      })
      .returning();
    pairId = pair.id;
    await database.db.insert(groupMeta).values({ threadId, metaEndId: 10 });
    await database.db.insert(profileTable).values([
      {
        account: 'alice',
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 1,
        generatedAt: 1,
        displayName: 'Friendly ALICE',
      },
      {
        account: 'alice',
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 2,
        generatedAt: 2,
        displayName: 'Wrong revision',
      },
      {
        account: 'alice',
        publisherNamespaceId: peerId,
        profileNamespaceId: 0,
        profileRev: 1,
        generatedAt: 1,
        displayName: 'Mirror selected name',
      },
    ]);
  });

  beforeEach(async () => {
    await database.db
      .update(messageThread)
      .set({ authorityNamespaceId: 0, groupAccountId: localGroupAccountId })
      .where(eq(messageThread.id, threadId));
    await database.db
      .update(relationshipPair)
      .set({ active: true })
      .where(eq(relationshipPair.id, pairId));
    await database.db
      .update(groupMeta)
      .set({
        metaEndId: 10,
        clientMetaEndId: 10,
        metaTargetId: 10,
        metaProcessedThroughId: 10,
        metaRecoveryThroughId: 0,
      })
      .where(eq(groupMeta.threadId, threadId));
    await database.db
      .delete(groupMetaMemberFeed)
      .where(eq(groupMetaMemberFeed.threadId, threadId));
    await database.db.insert(groupMetaMemberFeed).values([
      {
        threadId,
        feedId: 1,
        operation: 'MEMBER_UPSERT',
        body: {
          account: 'alice',
          namespaceId: 0,
          profileRev: 1,
          role: 'ADMIN',
        },
      },
      {
        threadId,
        feedId: 2,
        operation: 'MEMBER_UPSERT',
        body: {
          account: 'alice',
          namespaceId: 77,
          profileRev: 0,
          role: 'MEMBER',
        },
      },
      {
        threadId,
        feedId: 3,
        operation: 'MEMBER_UPSERT',
        body: { account: self, namespaceId: 0, profileRev: 0, role: 'OWNER' },
      },
      {
        threadId,
        feedId: 4,
        operation: 'MEMBER_DEPART',
        body: {
          account: 'departed',
          namespaceId: 0,
          profileRev: 0,
          role: 'MEMBER',
        },
      },
      {
        threadId,
        feedId: 5,
        operation: 'GROUP_PROFILE',
        body: { account: '!member-query', namespaceId: 0, profileRev: 0 },
      },
    ]);
  });

  afterAll(async () => {
    await module?.close();
  });

  it('paginates duplicate accounts by namespace without exposing profile content', async () => {
    const first = await service.query(userId, { threadId, take: 1 });
    expect(first.items).toEqual([
      {
        account: 'alice',
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 1,
        role: 'ADMIN',
      },
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.query(userId, {
      threadId,
      take: 1,
      cursor: first.nextCursor,
    });
    expect(second.items[0].profileNamespaceId).toBe(77);
    const last = await service.query(userId, {
      threadId,
      take: 1,
      cursor: second.nextCursor,
    });
    expect(last.items[0].account).toBe(self);
    expect(last.nextCursor).toBeNull();
  });

  it('searches literal account/name substrings using only the selected profile', async () => {
    expect(
      (await service.query(userId, { threadId, search: '  fRiEnDlY  ' })).items,
    ).toHaveLength(1);
    expect(
      (await service.query(userId, { threadId, search: 'ALICE' })).items,
    ).toHaveLength(2);
    for (const search of ['%', '_', 'Wrong revision', 'Mirror selected name'])
      expect((await service.query(userId, { threadId, search })).items).toEqual(
        [],
      );
  });

  it('excludes self and rejects cursors with changed filters', async () => {
    const page = await service.query(userId, {
      threadId,
      excludeSelf: true,
      take: 1,
    });
    const tail = await service.query(userId, {
      threadId,
      excludeSelf: true,
      cursor: page.nextCursor,
    });
    expect([...page.items, ...tail.items].map((item) => item.account)).toEqual([
      'alice',
      'alice',
    ]);
    await expect(
      service.query(userId, { threadId, cursor: page.nextCursor }),
    ).rejects.toThrow('invalid group member cursor');
  });

  it('checks current authorization on every page, including after revocation', async () => {
    await expect(service.query(outsiderId, { threadId })).rejects.toThrow(
      'not visible',
    );
    const page = await service.query(userId, { threadId, take: 1 });
    await database.db
      .update(relationshipPair)
      .set({ active: false })
      .where(eq(relationshipPair.id, pairId));
    await expect(
      service.query(userId, { threadId, cursor: page.nextCursor }),
    ).rejects.toThrow('not visible');
  });

  it('continues by identity when membership changes between pages', async () => {
    const first = await service.query(userId, { threadId, take: 1 });
    await database.db
      .delete(groupMetaMemberFeed)
      .where(
        and(
          eq(groupMetaMemberFeed.threadId, threadId),
          eq(groupMetaMemberFeed.feedId, 1),
        ),
      );
    await database.db.insert(groupMetaMemberFeed).values({
      threadId,
      feedId: 6,
      operation: 'MEMBER_UPSERT',
      body: { account: 'aaron', namespaceId: 0, profileRev: 0, role: 'MEMBER' },
    });
    const next = await service.query(userId, {
      threadId,
      cursor: first.nextCursor,
    });
    expect(
      next.items.map((item) => [item.account, item.profileNamespaceId]),
    ).toEqual([
      ['alice', 77],
      [self, 0],
    ]);
    expect((await service.query(userId, { threadId })).items[0].account).toBe(
      'aaron',
    );
  });

  it('rejects dissolved groups even when an active pair remains', async () => {
    await database.db
      .update(groupAccount)
      .set({ dissolvedAt: new Date() })
      .where(eq(groupAccount.id, localGroupAccountId));
    try {
      await expect(service.query(userId, { threadId })).rejects.toThrow(
        'not visible',
      );
    } finally {
      await database.db
        .update(groupAccount)
        .set({ dissolvedAt: null })
        .where(eq(groupAccount.id, localGroupAccountId));
    }
  });

  it('uses the mirror publisher for profiles and recognized namespace for self', async () => {
    await database.db
      .update(messageThread)
      .set({ authorityNamespaceId: peerId, groupAccountId: null })
      .where(eq(messageThread.id, threadId));
    await database.db
      .update(groupMetaMemberFeed)
      .set({
        body: { account: self, namespaceId: 77, profileRev: 0, role: 'OWNER' },
      })
      .where(
        and(
          eq(groupMetaMemberFeed.threadId, threadId),
          eq(groupMetaMemberFeed.feedId, 3),
        ),
      );
    const page = await service.query(userId, { threadId, excludeSelf: true });
    expect(page.items).toHaveLength(2);
    expect(
      page.items.every((item) => item.publisherNamespaceId === peerId),
    ).toBe(true);
    expect(
      (await service.query(userId, { threadId, search: 'Mirror selected' }))
        .items,
    ).toHaveLength(1);
    expect(
      (await service.query(userId, { threadId, search: 'Friendly' })).items,
    ).toEqual([]);
  });

  it('waits for initial mirror state but serves committed members during recovery', async () => {
    await database.db
      .update(messageThread)
      .set({ authorityNamespaceId: peerId, groupAccountId: null })
      .where(eq(messageThread.id, threadId));
    await database.db
      .update(groupMeta)
      .set({
        metaEndId: 0,
        clientMetaEndId: 0,
        metaProcessedThroughId: 0,
        metaRecoveryThroughId: 10,
      })
      .where(eq(groupMeta.threadId, threadId));
    await expect(service.query(userId, { threadId })).rejects.toThrow(
      'not ready',
    );
    await database.db
      .update(groupMeta)
      .set({ metaEndId: 5 })
      .where(eq(groupMeta.threadId, threadId));
    // Receiving canonical facts alone is not a committed client projection.
    await expect(service.query(userId, { threadId })).rejects.toThrow(
      'not ready',
    );
    await database.db
      .update(groupMeta)
      .set({ clientMetaEndId: 5 })
      .where(eq(groupMeta.threadId, threadId));
    expect((await service.query(userId, { threadId })).items).toHaveLength(3);
  });
});
