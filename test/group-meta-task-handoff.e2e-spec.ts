import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import {
  durableTask,
  groupMeta,
  messageThread,
} from '../src/database/schema.js';
import { DurableTaskStoreService } from '../src/durable-task/durable-task-store.service.js';
import { FederationGroupMetaTaskCoordinator } from '../src/federation/federation-group-meta-task-coordinator.service.js';
import { GroupMetaSyncTaskExecutionService } from '../src/federation/group-meta-sync-task-execution.service.js';
import { seedFederatedPeerNamespace } from './seed.js';

describe('Group Meta handoff after predecessor completion', () => {
  let database: DatabaseService;
  let store: DurableTaskStoreService;
  let coordinator: FederationGroupMetaTaskCoordinator;
  let execution: GroupMetaSyncTaskExecutionService;
  let namespaceId: number;
  let groupId: number;
  const peerDomain = 'handoff.test';
  const groupAccount = '!handoff';
  const ensure = async (through: bigint) => {
    const result = await coordinator.ensure({
      groupId,
      groupAccount,
      peerDomain,
      namespaceId,
      through,
    });
    if (result.ready) throw new Error('expected pending work');
    return result.taskId;
  };

  beforeAll(async () => {
    database = new DatabaseService();
    store = new DurableTaskStoreService(database);
    coordinator = new FederationGroupMetaTaskCoordinator(database);
    execution = new GroupMetaSyncTaskExecutionService(
      database,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    namespaceId = await seedFederatedPeerNamespace(database.db, peerDomain);
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'GROUP',
        groupAccount,
        groupDomain: peerDomain,
        authorityNamespaceId: namespaceId,
        updatedAt: new Date(),
      })
      .returning();
    groupId = thread.id;
  });
  afterAll(async () => database.onApplicationShutdown());
  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "DurableTask" RESTART IDENTITY CASCADE',
    );
    await database.db.delete(groupMeta).where(eq(groupMeta.threadId, groupId));
  });

  it.each([null, 5n])(
    'releases a failed predecessor without assuming its target was committed (feed: %s)',
    async (metaEndId) => {
      if (metaEndId !== null)
        await database.db
          .insert(groupMeta)
          .values({ threadId: groupId, metaEndId });
      const first = await ensure(10n);
      await store.claim(first);
      const second = await ensure(20n);
      await store.markFailed(first, 'expected failure');
      // A fresh ensure must not reject the lane because a failed row exists.
      expect(await ensure(20n)).toBe(second);
      expect(
        (await store.findEligible(['SYNC_GROUP_META'], 8)).map(({ id }) => id),
      ).toEqual([second]);
      const task = (await store.claim(second))!;
      // Also repair admission checkpoints persisted by earlier implementations.
      await database.db
        .update(durableTask)
        .set({
          checkpoint: {
            phase: 'PULL',
            mode: 'delta',
            after: '10',
            through: '20',
          },
        })
        .where(eq(durableTask.id, second));
      await expect(execution.prepare(task)).resolves.toEqual({ ready: false });
      const current = await database.db.query.durableTask.findFirst({
        where: eq(durableTask.id, second),
      });
      expect(current?.checkpoint).toEqual({
        phase: 'PULL',
        mode: metaEndId === null ? 'full' : 'delta',
        after: (metaEndId ?? 0n).toString(),
        through: '20',
      });
    },
  );

  it.each([10n, 25n])(
    'refreshes progress at execution and skips already-covered targets (feed: %s)',
    async (metaEndId) => {
      await database.db
        .insert(groupMeta)
        .values({ threadId: groupId, metaEndId: 5n });
      const first = await ensure(10n);
      await store.claim(first);
      const second = await ensure(20n);
      await database.db
        .update(groupMeta)
        .set({ metaEndId })
        .where(eq(groupMeta.threadId, groupId));
      await store.markSucceeded(first);
      const task = (await store.claim(second))!;
      await expect(execution.prepare(task)).resolves.toEqual({
        ready: metaEndId >= 20n,
      });
      if (metaEndId < 20n) {
        const current = await database.db.query.durableTask.findFirst({
          where: eq(durableTask.id, second),
        });
        expect(current?.checkpoint).toEqual({
          phase: 'PULL',
          mode: 'delta',
          after: '10',
          through: '20',
        });
      }
    },
  );
});
