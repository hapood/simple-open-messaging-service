import { Test, type TestingModule } from '@nestjs/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { isUniqueViolation } from '../src/database/database-error.js';
import { durableTask } from '../src/database/schema.js';
import { DurableTaskQueueService } from '../src/durable-task/durable-task-queue.service.js';
import { DurableTaskStoreService } from '../src/durable-task/durable-task-store.service.js';

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
    await database.pool.query(
      'TRUNCATE TABLE "DurableTask" RESTART IDENTITY CASCADE',
    );
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

  it('merges concurrent identical pending leaves into one durable row', async () => {
    const scope = {
      type: 'GROUP' as const,
      address: { domain: 'local', account: '!group-1' },
    };
    const admissions = await Promise.all(
      Array.from({ length: 8 }, () =>
        queue.enqueueTask({
          scope,
          taskType: 'LEAVE_GROUP',
          actorUserId: 11,
          payload: { threadId: 42 },
        }),
      ),
    );

    expect(new Set(admissions.map(({ taskId }) => taskId))).toEqual(
      new Set([admissions[0].taskId]),
    );
    const rows = await database.db.select().from(durableTask);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: admissions[0].taskId,
      taskType: 'LEAVE_GROUP',
      status: 'PENDING',
      coalescingKey: JSON.stringify(['GROUP_MEMBER_INTENT', 'MEMBER', 11]),
    });
  });

  it('rewrites an unclaimed member-intent lane tail without changing its task ID', async () => {
    const scope = {
      type: 'GROUP' as const,
      address: { domain: 'local', account: '!group-1' },
    };
    const leave = await queue.enqueueTask({
      scope,
      taskType: 'LEAVE_GROUP',
      actorUserId: 11,
      payload: { threadId: 42 },
    });
    const accept = await queue.enqueueTask({
      scope,
      taskType: 'ACCEPT_GROUP_INVITATION',
      actorUserId: 11,
      payload: { threadId: 42 },
    });

    expect(accept.taskId).toBe(leave.taskId);
    const rows = await database.db.select().from(durableTask);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: leave.taskId,
      taskType: 'ACCEPT_GROUP_INVITATION',
      actorUserId: 11,
      payload: { threadId: 42 },
      status: 'PENDING',
    });
  });

  it('allows only one concurrent conditional claim', async () => {
    const { taskId } = await queue.enqueueTask({
      scope: {
        type: 'GROUP',
        address: { domain: 'chat.example', account: 'group-1' },
      },
      taskType: 'DISBAND_GROUP',
      actorUserId: 11,
      payload: {},
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

  it('keeps an async task outside the executor while retaining its scope lane', async () => {
    const scope = {
      type: 'GROUP' as const,
      address: { domain: 'chat.example', account: 'group-1' },
    };
    const first = await queue.enqueueTask({
      scope,
      taskType: 'SYNC_GROUP_META',
      payload: {},
    });
    await expect(store.claim(first.taskId)).resolves.toBeDefined();
    await database.db
      .update(durableTask)
      .set({ status: 'ASYNC_PROCESSING' })
      .where(eq(durableTask.id, first.taskId));
    const second = await queue.enqueueTask({
      scope,
      taskType: 'SYNC_GROUP_META',
      payload: {},
    });

    await expect(store.findEligible(['SYNC_GROUP_META'], 10)).resolves.toEqual(
      [],
    );
    await expect(
      database.db
        .update(durableTask)
        .set({ status: 'PROCESSING', startedAt: new Date() })
        .where(eq(durableTask.id, second.taskId)),
    ).rejects.toSatisfy(isUniqueViolation);

    const row = await database.db.query.durableTask.findFirst({
      where: eq(durableTask.id, first.taskId),
    });
    expect(row?.status).toBe('ASYNC_PROCESSING');
    expect(row?.completedAt).toBeNull();
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
        taskType: 'FAN_OUT_GROUP_META_HEAD',
        payload: {},
      })
      .returning({ taskId: durableTask.id });

    const eligible = await store.findEligible(
      ['GROUP_MUTATION', 'FAN_OUT_GROUP_META_HEAD'],
      10,
    );
    expect(eligible.map(({ id }) => id)).toEqual([
      mutation.taskId,
      projection.taskId,
    ]);
    await expect(store.claim(mutation.taskId)).resolves.toBeDefined();
    await expect(store.claim(projection.taskId)).resolves.toBeDefined();
  });

  it('retains a pending task as superseded history linked to its replacement', async () => {
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
        supersededByTaskId: replacement.id,
        completedAt: new Date(),
      })
      .where(eq(durableTask.id, older.id));

    const row = await database.db.query.durableTask.findFirst({
      where: eq(durableTask.id, older.id),
    });
    expect(row).toMatchObject({
      status: 'SUPERSEDED',
      supersededByTaskId: replacement.id,
    });
    await expect(eligibleIds('SET_FRIEND_INTENT')).resolves.toEqual([
      replacement.id,
    ]);
  });

  it('blocks successors behind pending, processing, and failed tasks but not rejected ones', async () => {
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
    expect(eligibleAfterFailure).not.toContain(third.taskId);
  });

  it('atomically supersedes a pending Group Meta head fan-out', async () => {
    const input = {
      group: { domain: 'local', account: '!group-1' },
      threadId: 42,
    };
    const first = await database.db.transaction((tx) =>
      queue.enqueueGroupMetaHeadFanoutInTx(tx, input),
    );
    const second = await database.db.transaction((tx) =>
      queue.enqueueGroupMetaHeadFanoutInTx(tx, input),
    );

    const rows = await database.db
      .select()
      .from(durableTask)
      .orderBy(asc(durableTask.id));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: first.taskId,
      kind: 'PROJECTION',
      taskType: 'FAN_OUT_GROUP_META_HEAD',
      status: 'SUPERSEDED',
      supersededByTaskId: second.taskId,
      payload: { threadId: 42 },
      checkpoint: { afterAudienceId: '0' },
    });
    expect(rows[0].completedAt).not.toBeNull();
    expect(rows[1]).toMatchObject({
      id: second.taskId,
      kind: 'PROJECTION',
      taskType: 'FAN_OUT_GROUP_META_HEAD',
      status: 'PENDING',
      supersededByTaskId: null,
      payload: { threadId: 42 },
      checkpoint: { afterAudienceId: '0' },
      coalescingKey: JSON.stringify(['FAN_OUT_GROUP_META_HEAD', 42]),
    });
  });

  it('leaves processing projection immutable and replaces only its pending successor', async () => {
    const input = {
      group: { domain: 'local', account: '!group-1' },
      threadId: 42,
    };
    const processing = await database.db.transaction((tx) =>
      queue.enqueueGroupMetaHeadFanoutInTx(tx, input),
    );
    await expect(store.claim(processing.taskId)).resolves.toBeDefined();
    const olderSuccessor = await database.db.transaction((tx) =>
      queue.enqueueGroupMetaHeadFanoutInTx(tx, input),
    );
    const replacement = await database.db.transaction((tx) =>
      queue.enqueueGroupMetaHeadFanoutInTx(tx, input),
    );

    const rows = await database.db
      .select()
      .from(durableTask)
      .orderBy(asc(durableTask.id));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      id: processing.taskId,
      status: 'PROCESSING',
      supersededByTaskId: null,
      payload: { threadId: 42 },
    });
    expect(rows[1]).toMatchObject({
      id: olderSuccessor.taskId,
      status: 'SUPERSEDED',
      supersededByTaskId: replacement.taskId,
      payload: { threadId: 42 },
    });
    expect(rows[2]).toMatchObject({
      id: replacement.taskId,
      status: 'PENDING',
      payload: { threadId: 42 },
      checkpoint: { afterAudienceId: '0' },
    });
  });

  it('serializes concurrent fan-out coalescing to one pending successor', async () => {
    const admissionCount = 8;
    const admissions = await Promise.allSettled(
      Array.from({ length: admissionCount }, () =>
        database.db.transaction((tx) =>
          queue.enqueueGroupMetaHeadFanoutInTx(tx, {
            group: { domain: 'local', account: '!group-1' },
            threadId: 42,
          }),
        ),
      ),
    );
    expect(admissions.every(({ status }) => status === 'fulfilled')).toBe(true);

    const rows = await database.db
      .select()
      .from(durableTask)
      .orderBy(asc(durableTask.id));
    expect(rows).toHaveLength(admissionCount);
    expect(rows.filter(({ status }) => status === 'PENDING')).toHaveLength(1);
    expect(rows.filter(({ status }) => status === 'SUPERSEDED')).toHaveLength(
      admissionCount - 1,
    );
    expect(rows.at(-1)).toMatchObject({
      status: 'PENDING',
      payload: { threadId: 42 },
      checkpoint: { afterAudienceId: '0' },
    });
  });

  it('rolls projection admission back with its outer mutation transaction', async () => {
    await expect(
      database.db.transaction(async (tx) => {
        await queue.enqueueGroupMetaHeadFanoutInTx(tx, {
          group: { domain: 'local', account: '!group-1' },
          threadId: 42,
        });
        throw new Error('force authoritative mutation rollback');
      }),
    ).rejects.toThrow('force authoritative mutation rollback');

    await expect(database.db.select().from(durableTask)).resolves.toEqual([]);
  });

  async function eligibleIds(taskType: string): Promise<bigint[]> {
    return (await store.findEligible([taskType], 20)).map(({ id }) => id);
  }
});
