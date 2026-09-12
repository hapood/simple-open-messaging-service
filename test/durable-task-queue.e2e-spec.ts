import { FederationRelationshipTaskAdmission } from '../src/federation/federation-relationship-task-admission.service.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { isUniqueViolation } from '../src/database/database-error.js';
import { durableTask } from '../src/database/schema.js';
import { DurableTaskQueueService } from '../src/durable-task/durable-task-queue.service.js';
import { DurableTaskStoreService } from '../src/durable-task/durable-task-store.service.js';
import { saveTaskCheckpointInTx } from '../src/durable-task/task-checkpoint.js';

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

  it('coalesces group-authored revocations across operators but keeps the member direction separate', async () => {
    const scope = {
      type: 'GROUP' as const,
      address: { account: '!author-group', domain: 'local' },
    };
    const invite = await queue.enqueueTask({
      scope,
      taskType: 'INVITE_GROUP_MEMBER',
      actorUserId: 3,
      payload: { threadId: 10, targetUserId: 7 },
    });
    const leave = await queue.enqueueTask({
      scope,
      taskType: 'REVOKE_USER_RELATIONSHIP',
      actorUserId: 7,
      payload: { threadId: 10 },
    });
    const revoke = await queue.enqueueTask({
      scope,
      taskType: 'REVOKE_GROUP_RELATIONSHIP',
      actorUserId: 4,
      payload: {
        threadId: 10,
        memberUserId: 7,
        requestId: '1',
        operation: 'REVOKE_INVITATION',
      },
    });
    expect(revoke).toEqual(invite);
    expect(revoke.taskId).not.toBe(leave.taskId);
    const kick = await queue.enqueueTask({
      scope,
      taskType: 'REVOKE_GROUP_RELATIONSHIP',
      actorUserId: 3,
      payload: { threadId: 10, targetUserId: 7, operation: 'KICK' },
    });
    expect(kick).toEqual(invite);
    const ack = await queue.enqueueTask({
      scope,
      taskType: 'ACCEPT_GROUP_JOIN_REQUEST',
      actorUserId: 4,
      payload: { threadId: 10, memberUserId: 7, requestId: '2' },
    });
    expect(ack).toEqual(invite);
    const rows = await database.db.select().from(durableTask);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === leave.taskId)?.taskType).toBe(
      'REVOKE_USER_RELATIONSHIP',
    );
  });

  it('replaces same-direction pending req/ack/revoke across opposite work and suppresses running duplicates', async () => {
    const scope = {
      type: 'USER_PAIR' as const,
      endpoints: [
        { account: 'alice', domain: 'local' },
        { account: 'bob', domain: 'local' },
      ] as const,
    };
    const revoke = {
      scope,
      taskType: 'REVOKE_USER_RELATIONSHIP',
      actorUserId: 1,
      payload: { threadId: 10 },
    };
    const first = await queue.enqueueTask(revoke);
    const reverse = await queue.enqueueTask({ ...revoke, actorUserId: 2 });
    const ack = await queue.enqueueTask({
      ...revoke,
      taskType: 'REJECT_RELATIONSHIP_REQUEST',
      payload: { peerUserId: 2 },
    });
    expect(ack.taskId).toBe(first.taskId);
    expect(reverse.taskId).not.toBe(first.taskId);
    expect(await queue.enqueueTask(revoke)).toEqual(first);
    await database.db
      .update(durableTask)
      .set({ status: 'PROCESSING', startedAt: new Date() })
      .where(eq(durableTask.id, first.taskId));
    expect(await queue.enqueueTask(revoke)).toEqual(first);
    expect(await database.db.select().from(durableTask)).toHaveLength(2);
    const next = await queue.enqueueTask({
      ...revoke,
      taskType: 'REVOKE_ADDRESSED_RELATIONSHIP_REQUEST',
      payload: { account: 'bob', domain: 'peer.test' },
    });
    expect(next.taskId).not.toBe(first.taskId);
    expect(
      (
        await database.db.query.durableTask.findFirst({
          where: eq(durableTask.id, first.taskId),
        })
      )?.status,
    ).toBe('PROCESSING');
  });

  it.each(['PROCESSING', 'ASYNC_PROCESSING'] as const)(
    'guards and rolls back checkpoint writes for %s',
    async (status) => {
      const startedAt = new Date();
      const [task] = await database.db
        .insert(durableTask)
        .values({
          kind: 'PROJECTION',
          scopeType: 'GROUP',
          scopeKey: 'checkpoint-test',
          taskType: 'SYNC_GROUP_META',
          status,
          payload: {},
          createdAt: startedAt,
          startedAt,
          checkpoint: { after: '0' },
        })
        .returning();
      await database.db.transaction((tx) =>
        saveTaskCheckpointInTx(tx, task.id, { after: '1' }, status),
      );
      const other = status === 'PROCESSING' ? 'ASYNC_PROCESSING' : 'PROCESSING';
      await expect(
        database.db.transaction((tx) =>
          saveTaskCheckpointInTx(tx, task.id, { after: '2' }, other),
        ),
      ).rejects.toThrow('Task is not processing');
      await expect(
        database.db.transaction(async (tx) => {
          await saveTaskCheckpointInTx(tx, task.id, { after: '3' }, status);
          throw new Error('rollback checkpoint');
        }),
      ).rejects.toThrow('rollback checkpoint');
      const persisted = await database.db.query.durableTask.findFirst({
        where: eq(durableTask.id, task.id),
      });
      expect(persisted?.checkpoint).toEqual({ after: '1' });
      expect(persisted?.status).toBe(status);
    },
  );

  it('coalesces remote revoke retries and lets a later request replace pending remote work', async () => {
    const admission = new FederationRelationshipTaskAdmission(queue);
    const item = {
      account: 'remote-author',
      peerAccount: 'local-member',
      eventType: 'RELATIONSHIP_INTENT' as const,
      feedId: '10',
      body: {
        status: 'REVOKED',
        profileRev: 0,
        note: '',
        requestedAt: null,
        expiresAt: null,
      },
    };
    await database.db.transaction((tx) =>
      admission.deferInTx(tx, 'remote.test', 19, item),
    );
    const [first] = await database.db.select().from(durableTask);
    await database.db.transaction((tx) =>
      admission.deferInTx(tx, 'remote.test', 19, { ...item, feedId: '11' }),
    );
    expect(await database.db.select().from(durableTask)).toHaveLength(1);
    expect((await database.db.select().from(durableTask))[0].payload).toEqual(
      first.payload,
    );
    const request = {
      ...item,
      feedId: '12',
      body: { ...item.body, status: 'REQUESTED' },
    };
    await database.db.transaction((tx) =>
      admission.deferInTx(tx, 'remote.test', 19, request),
    );
    const [replaced] = await database.db.select().from(durableTask);
    expect(replaced.id).toBe(first.id);
    expect(replaced.actorUserId).toBeNull();
    expect(replaced.payload).toMatchObject({
      initiator: { account: 'remote-author', domain: 'remote.test' },
      item: { body: { status: 'REQUESTED' } },
    });
    const running = await store.claim(replaced.id);
    await database.db.transaction((tx) =>
      admission.deferInTx(tx, 'remote.test', 19, item),
    );
    const rows = await database.db
      .select()
      .from(durableTask)
      .orderBy(asc(durableTask.id));
    expect(rows).toHaveLength(2);
    expect(rows[0].payload).toEqual(running!.payload);
    expect(rows[1]).toMatchObject({
      status: 'PENDING',
      payload: { item: { body: { status: 'REVOKED' } } },
    });
  });

  it('keeps a pending forced revoke only in its own direction and only while pending', async () => {
    const scope = {
      type: 'GROUP' as const,
      address: { account: '!forced', domain: 'local' },
    };
    const forced = await database.db.transaction((tx) =>
      queue.enqueueTaskInTx(tx, {
        scope,
        taskType: 'FORCE_REVOKE_GROUP_MEMBER',
        payload: { threadId: 10, memberUserId: 7 },
      }),
    );
    for (const request of [
      {
        taskType: 'ACCEPT_GROUP_JOIN_REQUEST',
        actorUserId: 7,
        payload: { threadId: 10, memberUserId: 7, requestId: '1' },
      },
      {
        taskType: 'INVITE_GROUP_MEMBER',
        actorUserId: 3,
        payload: { threadId: 10, targetUserId: 7 },
      },
    ]) {
      expect(await queue.enqueueTask({ scope, ...request })).toEqual(forced);
      expect(
        await database.db.query.durableTask.findFirst({
          where: eq(durableTask.id, forced.taskId),
        }),
      ).toMatchObject({
        taskType: 'FORCE_REVOKE_GROUP_MEMBER',
        status: 'PENDING',
        payload: { threadId: 10, memberUserId: 7 },
      });
    }
    expect(await database.db.select().from(durableTask)).toHaveLength(1);
    const opposite = await queue.enqueueTask({
      scope,
      taskType: 'ACCEPT_GROUP_INVITATION',
      actorUserId: 7,
      payload: { threadId: 10 },
    });
    expect(opposite.taskId).not.toBe(forced.taskId);
    await database.db
      .update(durableTask)
      .set({ status: 'PROCESSING', startedAt: new Date() })
      .where(eq(durableTask.id, forced.taskId));
    const request = await queue.enqueueTask({
      scope,
      taskType: 'ACCEPT_GROUP_JOIN_REQUEST',
      actorUserId: 7,
      payload: { threadId: 10, memberUserId: 7, requestId: '1' },
    });
    expect(request.taskId).not.toBe(forced.taskId);
    expect(await database.db.select().from(durableTask)).toHaveLength(3);
  });

  it.each(['INVITE_GROUP_MEMBER', 'ACCEPT_GROUP_JOIN_REQUEST'])(
    'replaces pending %s with forced revoke in place despite later group work',
    async (taskType) => {
      const scope = {
        type: 'GROUP' as const,
        address: { account: '!replace', domain: 'local' },
      };
      const prior = await queue.enqueueTask({
        scope,
        taskType,
        actorUserId: 3,
        payload:
          taskType === 'INVITE_GROUP_MEMBER'
            ? { threadId: 10, targetUserId: 7 }
            : { threadId: 10, memberUserId: 7, requestId: '1' },
      });
      const later = await queue.enqueueTask({
        scope,
        taskType: 'INVITE_GROUP_MEMBER',
        actorUserId: 3,
        payload: { threadId: 10, targetUserId: 8 },
      });
      const forced = await database.db.transaction((tx) =>
        queue.enqueueTaskInTx(tx, {
          scope,
          taskType: 'FORCE_REVOKE_GROUP_MEMBER',
          payload: { threadId: 10, memberUserId: 7 },
        }),
      );
      expect(forced).toEqual(prior);
      const rows = await database.db
        .select()
        .from(durableTask)
        .orderBy(asc(durableTask.id));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        id: prior.taskId,
        taskType: 'FORCE_REVOKE_GROUP_MEMBER',
      });
      expect(rows[1]).toMatchObject({
        id: later.taskId,
        taskType: 'INVITE_GROUP_MEMBER',
      });
    },
  );

  it('supersedes every older pending intent in the forced direction atomically', async () => {
    const scope = {
      type: 'GROUP' as const,
      address: { account: '!multiple-pending', domain: 'local' },
    };
    const invite = await queue.enqueueTask({
      scope,
      taskType: 'INVITE_GROUP_MEMBER',
      actorUserId: 3,
      payload: { threadId: 10, targetUserId: 7 },
    });
    const opposite = await queue.enqueueTask({
      scope,
      taskType: 'ACCEPT_GROUP_INVITATION',
      actorUserId: 7,
      payload: { threadId: 10 },
    });
    // Seed an older persisted queue shape with two same-direction pending rows.
    const original = (await database.db.query.durableTask.findFirst({
      where: eq(durableTask.id, invite.taskId),
    }))!;
    const [ack] = await database.db
      .insert(durableTask)
      .values({
        kind: original.kind,
        scopeType: original.scopeType,
        scopeKey: original.scopeKey,
        coalescingKey: original.coalescingKey,
        taskType: 'ACCEPT_GROUP_JOIN_REQUEST',
        actorUserId: 3,
        status: 'PENDING',
        payload: { threadId: 10, memberUserId: 7, requestId: '1' },
      })
      .returning({ taskId: durableTask.id });
    const force = (tx: Parameters<typeof queue.enqueueTaskInTx>[0]) =>
      queue.enqueueTaskInTx(tx, {
        scope,
        taskType: 'FORCE_REVOKE_GROUP_MEMBER',
        payload: { threadId: 10, memberUserId: 7 },
      });
    await expect(
      database.db.transaction(async (tx) => {
        expect(await force(tx)).toEqual(ack);
        throw new Error('rollback all replacements');
      }),
    ).rejects.toThrow('rollback all replacements');
    const rolledBack = await database.db.select().from(durableTask);
    expect(rolledBack.every((row) => row.status === 'PENDING')).toBe(true);
    expect(rolledBack.find((row) => row.id === ack.taskId)?.taskType).toBe(
      'ACCEPT_GROUP_JOIN_REQUEST',
    );

    expect(await database.db.transaction(force)).toEqual(ack);
    const rows = await database.db.select().from(durableTask);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.id === invite.taskId)).toMatchObject({
      status: 'SUPERSEDED',
      completedAt: expect.any(Date),
    });
    expect(rows.find((row) => row.id === opposite.taskId)).toMatchObject({
      status: 'PENDING',
      taskType: 'ACCEPT_GROUP_INVITATION',
    });
    expect(rows.find((row) => row.id === ack.taskId)).toMatchObject({
      status: 'PENDING',
      taskType: 'FORCE_REVOKE_GROUP_MEMBER',
    });
  });

  it('coalesces forced member-side revocation with member req and ack only', async () => {
    const scope = {
      type: 'GROUP' as const,
      address: { account: '!member-force', domain: 'peer.test' },
    };
    const request = await queue.enqueueTask({
      scope,
      taskType: 'REQUEST_FEDERATED_GROUP_JOIN',
      actorUserId: 7,
      payload: {},
    });
    const force = await queue.enqueueTask({
      scope,
      taskType: 'FORCE_REVOKE_GROUP_MEMBER',
      payload: {
        threadId: 10,
        memberUserId: 7,
        direction: 'MEMBER',
        peerDomain: 'peer.test',
        namespaceId: 5,
        expectedAuthorizationEpoch: 8,
      },
    });
    expect(force).toEqual(request);
    const ack = await queue.enqueueTask({
      scope,
      taskType: 'ACCEPT_ADDRESSED_GROUP_INVITATION',
      actorUserId: 7,
      payload: {},
    });
    expect(ack).toEqual(force);
    const opposite = await queue.enqueueTask({
      scope,
      taskType: 'INVITE_GROUP_MEMBER',
      actorUserId: 3,
      payload: { targetUserId: 7 },
    });
    expect(opposite.taskId).not.toBe(force.taskId);
    const parent = {
      scope,
      taskType: 'REVOKE_FORBIDDEN_GROUP',
      payload: {
        threadId: 10,
        peerDomain: 'peer.test',
        namespaceId: 5,
        expectedAuthorizationEpoch: 8,
      },
    };
    const first = await queue.enqueueTask(parent);
    const second = await queue.enqueueTask(parent);
    expect(first.taskId).not.toBe(second.taskId);
  });

  it('rolls back caller-owned admission and its pending replacement together', async () => {
    const scope = {
      type: 'GROUP' as const,
      address: { account: '!atomic', domain: 'local' },
    };
    const prior = await queue.enqueueTask({
      scope,
      taskType: 'INVITE_GROUP_MEMBER',
      actorUserId: 3,
      payload: { threadId: 10, targetUserId: 7 },
    });
    await expect(
      database.db.transaction(async (tx) => {
        expect(
          await queue.enqueueTaskInTx(tx, {
            scope,
            taskType: 'FORCE_REVOKE_GROUP_MEMBER',
            payload: { threadId: 10, memberUserId: 7 },
          }),
        ).toEqual(prior);
        throw new Error('rollback replacement');
      }),
    ).rejects.toThrow('rollback replacement');
    const [retained] = await database.db.select().from(durableTask);
    expect(retained.taskType).toBe('INVITE_GROUP_MEMBER');
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
      payload: { threadId: 42 },
      checkpoint: { afterAudienceId: '0' },
    });
    expect(rows[0].completedAt).not.toBeNull();
    expect(rows[1]).toMatchObject({
      id: second.taskId,
      kind: 'PROJECTION',
      taskType: 'FAN_OUT_GROUP_META_HEAD',
      status: 'PENDING',
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
      payload: { threadId: 42 },
    });
    expect(rows[1]).toMatchObject({
      id: olderSuccessor.taskId,
      status: 'SUPERSEDED',
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
