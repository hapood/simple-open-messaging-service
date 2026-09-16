import { Test, type TestingModule } from '@nestjs/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { durableTask } from '../src/database/schema.js';
import { DurableTaskQueueService } from '../src/durable-task/durable-task-queue.service.js';
import { DurableTaskStoreService } from '../src/durable-task/durable-task-store.service.js';
import { saveTaskCheckpointInTx } from '../src/durable-task/task-checkpoint.js';
import { truncateTablesForTest } from './support/truncate';

describe('durable task enqueue', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let queue: DurableTaskQueueService;
  let store: DurableTaskStoreService;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [DurableTaskQueueService, DurableTaskStoreService],
    }).compile();
    database = mod.get(DatabaseService);
    queue = mod.get(DurableTaskQueueService);
    store = mod.get(DurableTaskStoreService);
  });

  afterAll(async () => mod.close());

  beforeEach(async () => {
    await truncateTablesForTest(database.pool, 'TRUNCATE TABLE "DurableTask" RESTART IDENTITY CASCADE');
  });

  it('guards and rolls back checkpoint writes for a claimed task', async () => {
    const startedAt = new Date();
    const [task] = await database.db
      .insert(durableTask)
      .values({
        kind: 'PROJECTION',
        scopeType: 'GROUP',
        scopeKey: 'checkpoint-test',
        taskType: 'FAN_OUT_THREAD_CONTENT',
        status: 'PENDING',
        payload: {},
        createdAt: startedAt,
        checkpoint: { after: '0' },
      })
      .returning();
    // The write is guarded on the executor's PROCESSING claim.
    await expect(
      database.db.transaction((tx) =>
        saveTaskCheckpointInTx(tx, task.id, { after: '1' }),
      ),
    ).rejects.toThrow('Task is not processing');
    await database.db
      .update(durableTask)
      .set({ status: 'PROCESSING', startedAt })
      .where(eq(durableTask.id, task.id));
    await database.db.transaction((tx) =>
      saveTaskCheckpointInTx(tx, task.id, { after: '1' }),
    );
    await expect(
      database.db.transaction(async (tx) => {
        await saveTaskCheckpointInTx(tx, task.id, { after: '2' });
        throw new Error('rollback checkpoint');
      }),
    ).rejects.toThrow('rollback checkpoint');
    const persisted = await database.db.query.durableTask.findFirst({
      where: eq(durableTask.id, task.id),
    });
    expect(persisted?.checkpoint).toEqual({ after: '1' });
    expect(persisted?.status).toBe('PROCESSING');
  });

  it('persists concurrent equivalent requests as distinct ordered tasks', async () => {
    const scope = {
      type: 'USER_PAIR' as const,
      endpoints: [
        { domain: 'chat.example', account: 'alice' },
        { domain: 'remote.example', account: 'bob' },
      ] as const,
    };

    const results = await Promise.all([
      queue.enqueueTask({
        scope,
        taskType: 'SEND_FRIEND_REQUEST',
        actorUserId: 11,
        payload: { source: 'first' },
      }),
      queue.enqueueTask({
        scope,
        taskType: 'SEND_FRIEND_REQUEST',
        actorUserId: 11,
        payload: { source: 'second' },
      }),
    ]);

    expect(new Set(results.map(({ taskId }) => taskId)).size).toBe(2);
    const rows = await database.db
      .select({
        id: durableTask.id,
        scopeKey: durableTask.scopeKey,
        status: durableTask.status,
        payload: durableTask.payload,
      })
      .from(durableTask)
      .where(eq(durableTask.scopeType, 'USER_PAIR'))
      .orderBy(asc(durableTask.id));
    expect(rows).toHaveLength(2);
    expect(rows[0].scopeKey).toBe(rows[1].scopeKey);
    expect(rows.map(({ status }) => status)).toEqual(['PENDING', 'PENDING']);
    expect(rows.map(({ payload }) => payload.source).sort()).toEqual([
      'first',
      'second',
    ]);
  });

  it('allows only one concurrent conditional claim', async () => {
    const { taskId } = await queue.enqueueTask({
      scope: {
        type: 'GROUP',
        address: { domain: 'chat.example', account: 'group-1' },
      },
      taskType: 'DISBAND_GROUP',
      actorUserId: 11,
      payload: { threadId: 1 },
    });

    const claims = await Promise.all([
      store.claim(taskId),
      store.claim(taskId),
    ]);
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect(claims.find((claim) => claim !== undefined)?.status).toBe(
      'PROCESSING',
    );
  });

  it('runs mutation and projection lanes independently for one scope', async () => {
    const mutation = await queue.enqueueTask({
      scope: {
        type: 'GROUP',
        address: { domain: 'chat.example', account: 'group-1' },
      },
      taskType: 'GROUP_MUTATION',
      payload: {},
    });
    const mutationRow = await database.db.query.durableTask.findFirst({
      where: eq(durableTask.id, mutation.taskId),
    });
    expect(mutationRow).toBeDefined();

    const [projection] = await database.db
      .insert(durableTask)
      .values({
        kind: 'PROJECTION',
        scopeType: 'GROUP',
        scopeKey: mutationRow!.scopeKey,
        taskType: 'FAN_OUT_THREAD_CONTENT',
        payload: {},
      })
      .returning({ taskId: durableTask.id });

    const eligible = await store.findEligible(
      ['GROUP_MUTATION', 'FAN_OUT_THREAD_CONTENT'],
      10,
    );
    expect(eligible.map(({ id }) => id)).toEqual([
      mutation.taskId,
      projection.taskId,
    ]);
    await expect(store.claim(mutation.taskId)).resolves.toBeDefined();
    await expect(store.claim(projection.taskId)).resolves.toBeDefined();
  });

  it('retains superseded status without blocking the replacement task', async () => {
    const common = {
      kind: 'MUTATION' as const,
      scopeType: 'USER_PAIR' as const,
      scopeKey: 'pair-scope',
      taskType: 'SET_FRIEND_INTENT',
      coalescingKey: 'friend-intent:alice-to-bob',
      payload: {},
    };
    const [older] = await database.db
      .insert(durableTask)
      .values(common)
      .returning({ id: durableTask.id });
    const [replacement] = await database.db
      .insert(durableTask)
      .values(common)
      .returning({ id: durableTask.id });

    await database.db
      .update(durableTask)
      .set({
        status: 'SUPERSEDED',
        completedAt: new Date(),
      })
      .where(eq(durableTask.id, older.id));

    const row = await database.db.query.durableTask.findFirst({
      where: eq(durableTask.id, older.id),
    });
    expect(row).toMatchObject({
      status: 'SUPERSEDED',
    });
    await expect(eligibleIds('SET_FRIEND_INTENT')).resolves.toEqual([
      replacement.id,
    ]);
  });

  it('blocks successors behind unfinished tasks and releases them after rejection or failure', async () => {
    const groupScope = {
      type: 'GROUP' as const,
      address: { domain: 'chat.example', account: 'group-1' },
    };
    const otherScope = {
      type: 'GROUP' as const,
      address: { domain: 'chat.example', account: 'group-2' },
    };
    const first = await queue.enqueueTask({
      scope: groupScope,
      taskType: 'GROUP_MUTATION',
      payload: { ordinal: 1 },
    });
    const second = await queue.enqueueTask({
      scope: groupScope,
      taskType: 'GROUP_MUTATION',
      payload: { ordinal: 2 },
    });
    const unrelated = await queue.enqueueTask({
      scope: otherScope,
      taskType: 'GROUP_MUTATION',
      payload: { ordinal: 3 },
    });

    await expect(eligibleIds('GROUP_MUTATION')).resolves.toEqual([
      first.taskId,
      unrelated.taskId,
    ]);
    expect(await store.claim(first.taskId)).toBeDefined();
    await expect(eligibleIds('GROUP_MUTATION')).resolves.toEqual([
      unrelated.taskId,
    ]);

    await store.markRejected(first.taskId, 40001);
    await expect(eligibleIds('GROUP_MUTATION')).resolves.toEqual([
      second.taskId,
      unrelated.taskId,
    ]);

    expect(await store.claim(second.taskId)).toBeDefined();
    await store.markFailed(second.taskId, 'Unexpected task error (Error)');
    const third = await queue.enqueueTask({
      scope: groupScope,
      taskType: 'GROUP_MUTATION',
      payload: { ordinal: 4 },
    });
    const eligibleAfterFailure = await eligibleIds('GROUP_MUTATION');
    expect(eligibleAfterFailure).toContain(unrelated.taskId);
    expect(eligibleAfterFailure).toContain(third.taskId);
  });

  async function eligibleIds(taskType: string): Promise<bigint[]> {
    return (await store.findEligible([taskType], 20)).map(({ id }) => id);
  }
});
