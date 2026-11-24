import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  clientGroupMetaFeed,
  groupAccount,
  groupMeta,
  groupMetaMemberFeed,
  messageThread,
} from '../src/database/schema.js';
import { requireThreadContentLockInTx } from '../src/common/locks/thread-content-lock.js';
import { reconcileClientMemberCountInTx } from '../src/group/meta/reconcile-client-member-count-in-tx.js';
import { seedFederatedPeerNamespace } from './seed.js';

describe.each(['origin', 'mirror'] as const)(
  '%s client member count projection',
  (host) => {
    let module: TestingModule;
    let database: DatabaseService;
    let threadId: number;

    beforeAll(async () => {
      module = await Test.createTestingModule({
        imports: [DatabaseModule],
      }).compile();
      database = module.get(DatabaseService);
      const name = `!count-${host}`;
      const authorityNamespaceId =
        host === 'mirror'
          ? await seedFederatedPeerNamespace(database.db, 'count-mirror.test')
          : 0;
      const [group] =
        host === 'origin'
          ? await database.db
              .insert(groupAccount)
              .values({ account: name })
              .returning()
          : [];
      const [thread] = await database.db
        .insert(messageThread)
        .values({
          type: 'GROUP',
          groupAccount: name,
          groupAccountId: group?.id ?? null,
          authorityNamespaceId,
        })
        .returning();
      threadId = thread.id;
    });
    beforeEach(async () => {
      await database.db
        .delete(groupMetaMemberFeed)
        .where(eq(groupMetaMemberFeed.threadId, threadId));
      await database.db
        .delete(groupMeta)
        .where(eq(groupMeta.threadId, threadId));
      await database.db.insert(groupMeta).values({
        threadId,
        metaEndId: host === 'mirror' ? 0 : 40,
        metaTargetId: host === 'mirror' ? 950 : 0,
        metaProcessedThroughId: host === 'mirror' ? 900 : 0,
      });
    });
    afterAll(async () => {
      await module?.close();
    });

    const reconcile = () =>
      database.db.transaction(async (tx) => {
        const lock = await requireThreadContentLockInTx(tx, threadId);
        return reconcileClientMemberCountInTx(tx, lock);
      });
    const addMember = (feedId: number, account: string) =>
      database.db.insert(groupMetaMemberFeed).values({
        threadId,
        feedId,
        operation: 'MEMBER_UPSERT',
        body: { account, namespaceId: 0, profileRev: 0, role: 'MEMBER' },
      });

    it('initializes zero exactly once and preserves the row and allocator on replay', async () => {
      expect(await reconcile()).toEqual({
        changed: true,
        feedId: 1,
        memberCount: 0,
      });
      const [before] = await database.db
        .select()
        .from(clientGroupMetaFeed)
        .where(eq(clientGroupMetaFeed.threadId, threadId));
      expect(await reconcile()).toEqual({
        changed: false,
        feedId: 1,
        memberCount: 0,
      });
      const [after] = await database.db
        .select()
        .from(clientGroupMetaFeed)
        .where(eq(clientGroupMetaFeed.threadId, threadId));
      expect(after).toEqual(before);
      const [head] = await database.db
        .select()
        .from(groupMeta)
        .where(eq(groupMeta.threadId, threadId));
      expect(head.metaEndId).toBe(host === 'mirror' ? 0 : 40);
      expect(head.clientMetaEndId).toBe(1);
      expect(head.metaProcessedThroughId).toBe(host === 'mirror' ? 900 : 0);
      expect(head.metaTargetId).toBe(host === 'mirror' ? 950 : 0);
    });

    it('keeps client allocation independent of server-only progress', async () => {
      await reconcile();
      if (host === 'origin')
        await database.db
          .update(groupMeta)
          .set({ metaEndId: 1000 })
          .where(eq(groupMeta.threadId, threadId));
      expect(await reconcile()).toEqual({
        changed: false,
        feedId: 1,
        memberCount: 0,
      });
      await addMember(1000, 'alice');
      expect(await reconcile()).toEqual({
        changed: true,
        feedId: 2,
        memberCount: 1,
      });
      const [head] = await database.db
        .select()
        .from(groupMeta)
        .where(eq(groupMeta.threadId, threadId));
      expect(head.metaEndId).toBe(host === 'mirror' ? 0 : 1000);
      expect(head.clientMetaEndId).toBe(2);
    });

    it('counts members only and allocates one coordinate for a changed final batch', async () => {
      await reconcile();
      await addMember(1, 'alice');
      await addMember(2, 'bob');
      await database.db.insert(groupMetaMemberFeed).values([
        {
          threadId,
          feedId: 3,
          operation: 'MEMBER_DEPART',
          body: {
            account: 'left',
            namespaceId: 0,
            profileRev: 0,
            role: 'MEMBER',
          },
        },
        {
          threadId,
          feedId: 4,
          operation: 'GROUP_ANNOUNCEMENT',
          body: { text: null },
        },
      ]);
      expect(await reconcile()).toEqual({
        changed: true,
        feedId: 2,
        memberCount: 2,
      });
      expect(
        await database.db
          .select()
          .from(clientGroupMetaFeed)
          .where(eq(clientGroupMetaFeed.threadId, threadId)),
      ).toHaveLength(1);
    });

    it('does not allocate for role/profile refresh or equal-size membership replacement', async () => {
      await addMember(1, 'alice');
      await reconcile();
      await database.db
        .update(groupMetaMemberFeed)
        .set({
          body: {
            account: 'alice',
            namespaceId: 0,
            profileRev: 7,
            role: 'ADMIN',
          },
        })
        .where(eq(groupMetaMemberFeed.threadId, threadId));
      expect((await reconcile()).changed).toBe(false);
      await database.db.transaction(async (tx) => {
        const lock = await requireThreadContentLockInTx(tx, threadId);
        await tx
          .delete(groupMetaMemberFeed)
          .where(eq(groupMetaMemberFeed.threadId, threadId));
        await tx.insert(groupMetaMemberFeed).values({
          threadId,
          feedId: 2,
          operation: 'MEMBER_UPSERT',
          body: {
            account: 'bob',
            namespaceId: 0,
            profileRev: 0,
            role: 'MEMBER',
          },
        });
        expect(await reconcileClientMemberCountInTx(tx, lock)).toEqual({
          changed: false,
          feedId: 1,
          memberCount: 1,
        });
      });
    });

    it('rolls back allocation with the fact and retries without a consumed ID', async () => {
      await expect(
        database.db.transaction(async (tx) => {
          const lock = await requireThreadContentLockInTx(tx, threadId);
          await reconcileClientMemberCountInTx(tx, lock);
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await reconcile()).toEqual({
        changed: true,
        feedId: 1,
        memberCount: 0,
      });
    });

    it('serializes concurrent reconciliation without duplicate count allocation', async () => {
      await addMember(1, 'alice');
      const results = await Promise.all([reconcile(), reconcile()]);
      expect(results.filter((result) => result.changed)).toHaveLength(1);
      expect(results.map((result) => result.feedId)).toEqual([1, 1]);
    });

    it('publishes an explicit zero when the last member departs', async () => {
      await addMember(1, 'alice');
      await reconcile();
      await database.db
        .update(groupMetaMemberFeed)
        .set({ operation: 'MEMBER_DEPART' })
        .where(
          and(
            eq(groupMetaMemberFeed.threadId, threadId),
            eq(groupMetaMemberFeed.feedId, 1),
          ),
        );
      expect(await reconcile()).toEqual({
        changed: true,
        feedId: 2,
        memberCount: 0,
      });
    });
  },
);
