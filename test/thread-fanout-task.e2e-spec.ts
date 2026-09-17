import { parseAccountThreadFanoutTarget } from '../src/message/account-thread-fanout-task.js';
import { MessageVisibilityService } from '../src/message/message-visibility.service.js';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import {
  accountThreadState,
  relationshipPair,
  groupAccount,
  durableTask,
  messageThread,
  threadAudience,
} from '../src/database/schema.js';
import { DurableTaskStoreService } from '../src/durable-task/durable-task-store.service.js';
import { DurableTaskType } from '../src/durable-task/durable-task.constants.js';
import { acquireThreadContentLockInTx } from '../src/common/locks/thread-content-lock.js';
import {
  enqueueThreadFanoutInTx,
  enqueueMessageFanoutsInTx,
  threadFanoutScope,
} from '../src/message/thread-fanout-task.js';
import { FederationThreadFanoutTaskHandler } from '../src/federation/federation-thread-fanout-task.handler.js';
import { DurableTaskDispatcherService } from '../src/durable-task/durable-task-dispatcher.service.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { ThreadFanoutProgressService } from '../src/message/thread-fanout-progress.service.js';
import { MessageService } from '../src/message/message.service.js';
import { account, message, peerStateFeed } from '../src/database/schema.js';
import { seedAcceptedRelationship } from './seed.js';
import { FederationThreadContentHeadService } from '../src/federation/federation-thread-content-head.service.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import { truncateTablesForTest } from './support/truncate';

describe('transactional thread fanout queue', () => {
  const database = new DatabaseService();
  const store = new DurableTaskStoreService(database);
  const progress = new ThreadFanoutProgressService(
    database,
    new MessageVisibilityService(database),
  );
  const messages = new MessageService(database, {} as never, {} as never);
  let threadId: number;
  beforeAll(() => database.onModuleInit());
  afterAll(() => database.onApplicationShutdown());
  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE "MessageThread", "DurableTask" RESTART IDENTITY CASCADE',
    );
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: new Date() })
      .returning();
    threadId = thread.id;
  });
  const enqueue = (messageEndSeq: number, tombstoneEndSeq = 0) =>
    database.db.transaction(async (tx) => {
      const lock = (await acquireThreadContentLockInTx(tx, threadId))!;
      return enqueueThreadFanoutInTx(tx, lock, {
        threadId,
        messageEndSeq,
        tombstoneEndSeq,
      });
    });

  const federationType = DurableTaskType.FAN_OUT_FEDERATION_THREAD_CONTENT;
  const enqueueBoth = (messageEndSeq: number, tombstoneEndSeq = 0) =>
    database.db.transaction(async (tx) => {
      const lock = (await acquireThreadContentLockInTx(tx, threadId))!;
      await enqueueMessageFanoutsInTx(tx, lock, {
        threadId,
        messageEndSeq,
        tombstoneEndSeq,
      });
    });

  const federationFixture = async () => {
    const namespaces: number[] = [];
    for (const domain of ['fanout-a.test', 'fanout-b.test']) {
      const namespaceId = await seedFederatedPeerNamespace(database.db, domain);
      namespaces.push(namespaceId);
      await database.db.insert(threadAudience).values({
        threadId,
        targetDomain: domain,
        targetNamespaceId: namespaceId,
      });
    }
    const heads = { projectCurrentInTx: vi.fn().mockResolvedValue(true) };
    const events = { emit: vi.fn() };
    const handler = new FederationThreadFanoutTaskHandler(
      database,
      new DurableTaskDispatcherService(),
      heads as never,
      events as never,
    );
    await enqueueBoth(5, 3);
    const queued = (await database.db.select().from(durableTask)).find(
      (task) => task.taskType === federationType,
    )!;
    const task = (await store.claim(queued.id))!;
    return { handler, heads, events, task, namespaces };
  };

  const directedType = DurableTaskType.FAN_OUT_ACCOUNT_THREAD_CONTENT;
  async function departingPair() {
    const users = [];
    for (const name of ['direct-a', 'direct-b']) {
      const [user] = await database.db
        .insert(account)
        .values({ account: name })
        .onConflictDoUpdate({
          target: account.account,
          set: { updatedAt: new Date() },
        })
        .returning();
      users.push(user);
    }
    await seedAcceptedRelationship(
      database.db,
      users[0].id,
      users[1].id,
      threadId,
    );
    return users;
  }
  async function depart(users: Array<{ id: number }>) {
    await database.db.transaction(async (tx) => {
      // The event carries its own participants: the initiator (users[0]) is
      // the content fact; the departing users[1] needs no separate argument.
      const boundary = await messages.writeSystemMessageInTx(tx, threadId, {
        type: 'FRIEND_REMOVED',
        initiator: users[0].id,
      });
      await tx
        .update(accountThreadState)
        .set({ messageVisibleThroughSeq: boundary.message.seq })
        .where(eq(accountThreadState.threadId, threadId));
      await tx
        .update(relationshipPair)
        .set({ active: false })
        .where(eq(relationshipPair.threadId, threadId));
    });
    return (await database.db.select().from(durableTask)).filter(
      (task) => task.taskType === directedType,
    );
  }

  it('retains established membership and delivers departure independently of later ordinary work', async () => {
    const users = await departingPair();
    const directed = await depart(users);
    expect(directed).toHaveLength(2);
    await enqueue(99);
    expect(
      (
        await database.db.query.relationshipPair.findFirst({
          where: eq(relationshipPair.threadId, threadId),
        })
      )?.established,
    ).toBe(true);
    for (const queued of directed) {
      expect(queued.payload.messageEndSeq).toBe(1);
      const task = (await store.claim(queued.id))!;
      const target = parseAccountThreadFanoutTarget(task.payload);
      expect(await progress.projectAccount(task.id, target)).toHaveLength(1);
      const before = await database.db.query.accountThreadState.findFirst({
        where: eq(accountThreadState.accountId, target.accountId),
      });
      expect(before?.messageEndSeq).toBe(1);
      expect(await progress.projectAccount(task.id, target)).toEqual([]);
      const after = await database.db.query.accountThreadState.findFirst({
        where: eq(accountThreadState.accountId, target.accountId),
      });
      expect(after?.threadFeedId).toBe(before?.threadFeedId);
    }
  });

  it.each([
    'cleared',
    'beyond visibility',
    'already projected',
    'relationship removed',
    'thread removed',
  ])('completes without publishing when departure is %s', async (reason) => {
    const users = await departingPair();
    const [queued] = await depart(users);
    const task = (await store.claim(queued.id))!;
    const target = parseAccountThreadFanoutTarget(task.payload);
    if (reason === 'cleared')
      await database.db
        .update(messageThread)
        .set({ clearedSeq: 1 })
        .where(eq(messageThread.id, threadId));
    if (reason === 'beyond visibility')
      await database.db
        .update(accountThreadState)
        .set({ messageVisibleThroughSeq: 0 })
        .where(eq(accountThreadState.threadId, threadId));
    if (reason === 'already projected')
      await database.db
        .update(accountThreadState)
        .set({ messageEndSeq: 2 })
        .where(eq(accountThreadState.threadId, threadId));
    if (reason === 'relationship removed')
      await database.db
        .delete(relationshipPair)
        .where(eq(relationshipPair.threadId, threadId));
    if (reason === 'thread removed') {
      await database.db
        .delete(accountThreadState)
        .where(eq(accountThreadState.threadId, threadId));
      await database.db.delete(message).where(eq(message.threadId, threadId));
      await database.db
        .delete(messageThread)
        .where(eq(messageThread.id, threadId));
    }
    expect(await progress.projectAccount(task.id, target)).toEqual([]);
    expect(
      (
        await database.db.query.durableTask.findFirst({
          where: eq(durableTask.id, task.id),
        })
      )?.checkpoint.phase,
    ).toBe('DONE');
  });

  it('rolls departure tasks and the system message back with the relationship transaction', async () => {
    const users = await departingPair();
    await expect(
      database.db.transaction(async (tx) => {
        await messages.writeSystemMessageInTx(tx, threadId, {
          type: 'FRIEND_REMOVED',
          initiator: users[0].id,
        });
        throw new Error('departure rollback');
      }),
    ).rejects.toThrow('departure rollback');
    expect(await database.db.select().from(durableTask)).toEqual([]);
    expect(await database.db.select().from(message)).toEqual([]);
  });

  it('delivers to an established inactive group member without authorizing a request-only member', async () => {
    const [member] = await database.db
      .insert(account)
      .values({ account: 'direct-group-member' })
      .returning();
    const [group] = await database.db
      .insert(groupAccount)
      .values({ account: '!direct-group' })
      .returning();
    await database.db
      .update(messageThread)
      .set({
        type: 'GROUP',
        groupAccount: group.account,
        groupAccountId: group.id,
        groupDomain: 'local',
      })
      .where(eq(messageThread.id, threadId));
    const [pair] = await database.db
      .insert(relationshipPair)
      .values({
        kind: 'GROUP_MEMBER',
        endpointAType: 'GROUP',
        endpointAAccount: group.account,
        endpointADomain: 'local',
        endpointBType: 'USER',
        endpointBAccount: member.account,
        endpointBDomain: 'local',
        threadId,
      })
      .returning();
    await database.db
      .insert(accountThreadState)
      .values({ accountId: member.id, threadId });
    await messages.writeSystemMessage(threadId, {
      type: 'GROUP_LEFT',
      member: member.id,
    });
    const [first] = (await database.db.select().from(durableTask)).filter(
      (task) => task.taskType === directedType,
    );
    const firstTask = (await store.claim(first.id))!;
    expect(
      await progress.projectAccount(
        firstTask.id,
        parseAccountThreadFanoutTarget(firstTask.payload),
      ),
    ).toEqual([]);
    await database.db
      .update(durableTask)
      .set({ status: 'SUCCEEDED', completedAt: new Date() })
      .where(eq(durableTask.id, firstTask.id));
    await database.db
      .update(relationshipPair)
      .set({ active: true })
      .where(eq(relationshipPair.id, pair.id));
    await database.db.transaction(async (tx) => {
      const boundary = await messages.writeSystemMessageInTx(tx, threadId, {
        type: 'GROUP_LEFT',
        member: member.id,
      });
      await tx
        .update(accountThreadState)
        .set({ messageVisibleThroughSeq: boundary.message.seq })
        .where(eq(accountThreadState.accountId, member.id));
      await tx
        .update(relationshipPair)
        .set({ active: false, established: false })
        .where(eq(relationshipPair.id, pair.id));
    });
    const next = (await database.db.select().from(durableTask)).find(
      (task) => task.taskType === directedType && task.id !== first.id,
    )!;
    const task = (await store.claim(next.id))!;
    expect(
      await progress.projectAccount(
        task.id,
        parseAccountThreadFanoutTarget(task.payload),
      ),
    ).toHaveLength(1);
  });

  it('coalesces both task types independently and schedules neither behind the other', async () => {
    await enqueueBoth(5, 3);
    await enqueueBoth(6, 2);
    const eligible = await store.findEligible(
      [DurableTaskType.FAN_OUT_THREAD_CONTENT, federationType],
      10,
    );
    expect(eligible).toHaveLength(2);
    expect(new Set(eligible.map((task) => task.scopeKey)).size).toBe(2);
    for (const task of eligible) {
      expect(task.payload).toEqual({
        threadId,
        messageEndSeq: 6,
        tombstoneEndSeq: 3,
        profileRev: 0,
      });
      expect(task.scopeKey).toBe(
        threadFanoutScope(task.taskType as typeof federationType, threadId),
      );
    }
    await store.claim(eligible[0].id);
    expect(
      (await store.findEligible([federationType], 10)).map((task) => task.id),
    ).toEqual([eligible[1].id]);
  });

  it('rolls back both admitted fanouts with their source transaction', async () => {
    await expect(
      database.db.transaction(async (tx) => {
        const lock = (await acquireThreadContentLockInTx(tx, threadId))!;
        await enqueueMessageFanoutsInTx(tx, lock, {
          threadId,
          messageEndSeq: 5,
          tombstoneEndSeq: 2,
        });
        throw new Error('source rollback');
      }),
    ).rejects.toThrow('source rollback');
    expect(await database.db.select().from(durableTask)).toEqual([]);
  });

  it('resumes federation fanout after the committed peer cursor without replaying peers', async () => {
    const f = await federationFixture();
    f.heads.projectCurrentInTx
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('projection rollback'));
    await expect(f.handler.execute(f.task)).rejects.toThrow(
      'projection rollback',
    );
    const saved = await database.db.query.durableTask.findFirst({
      where: eq(durableTask.id, f.task.id),
    });
    expect(saved?.checkpoint).toEqual({
      phase: 'FEED',
      afterNamespaceId: f.namespaces[0],
    });
    expect(f.events.emit).toHaveBeenCalledTimes(1);
    await f.handler.execute(f.task);
    expect(
      f.heads.projectCurrentInTx.mock.calls.map((call) => call[1]),
    ).toEqual(['fanout-a.test', 'fanout-b.test', 'fanout-b.test']);
    expect(f.events.emit).toHaveBeenCalledTimes(2);
    expect(
      (
        await database.db.query.durableTask.findFirst({
          where: eq(durableTask.id, f.task.id),
        })
      )?.checkpoint,
    ).toEqual({ phase: 'DONE', afterNamespaceId: 0 });
  });

  it('yields only to its own newer federation task and preserves both heads', async () => {
    const f = await federationFixture();
    await enqueue(20, 20);
    let successor: bigint | undefined;
    f.heads.projectCurrentInTx.mockImplementationOnce(async (tx) => {
      const lock = (await acquireThreadContentLockInTx(tx, threadId))!;
      successor = await enqueueThreadFanoutInTx(
        tx,
        lock,
        {
          threadId,
          messageEndSeq: 6,
          tombstoneEndSeq: 2,
        },
        federationType,
      );
    });
    await f.handler.execute(f.task);
    expect(f.heads.projectCurrentInTx).toHaveBeenCalledTimes(1);
    const rows = await database.db.select().from(durableTask);
    expect(rows.find((task) => task.id === f.task.id)?.status).toBe(
      'SUCCEEDED',
    );
    expect(rows.find((task) => task.id === successor)).toMatchObject({
      status: 'PENDING',
      checkpoint: {},
      payload: { threadId, messageEndSeq: 6, tombstoneEndSeq: 3 },
    });
  });

  it('does not fail committed federation projection when wake registration throws', async () => {
    const f = await federationFixture();
    f.events.emit.mockImplementation(() => {
      throw new Error('lost wake');
    });
    await expect(f.handler.execute(f.task)).resolves.toBeUndefined();
    expect(f.heads.projectCurrentInTx).toHaveBeenCalledTimes(2);
  });

  it('rolls back projection writes if its checkpoint cannot commit', async () => {
    const f = await federationFixture();
    const before = await database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
    });
    f.heads.projectCurrentInTx.mockImplementationOnce(async (tx) => {
      await tx
        .update(messageThread)
        .set({ curSeq: 99 })
        .where(eq(messageThread.id, threadId));
      await tx
        .update(durableTask)
        .set({
          status: 'SUCCEEDED',
          completedAt: new Date(),
        })
        .where(eq(durableTask.id, f.task.id));
    });
    await expect(f.handler.execute(f.task)).rejects.toThrow(
      'Task is not processing',
    );
    expect(
      (
        await database.db.query.messageThread.findFirst({
          where: eq(messageThread.id, threadId),
        })
      )?.curSeq,
    ).toBe(before?.curSeq);
    expect(
      (
        await database.db.query.durableTask.findFirst({
          where: eq(durableTask.id, f.task.id),
        })
      )?.checkpoint,
    ).toEqual({});
    expect(f.events.emit).not.toHaveBeenCalled();
  });

  it('admits system-message fanout in its source transaction and coalesces repeated notices', async () => {
    await messages.writeSystemMessage(threadId, { type: 'FRIEND_ADDED' });
    await messages.writeSystemMessage(threadId, { type: 'FRIEND_ADDED' });
    const queued = await database.db.select().from(durableTask);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toEqual({
      threadId,
      messageEndSeq: 2,
      tombstoneEndSeq: 0,
      profileRev: 0,
    });
    expect(queued[0].status).toBe('PENDING');
  });

  it('does not leak system-message fanout after a relationship transaction rolls back', async () => {
    await expect(
      database.db.transaction(async (tx) => {
        await messages.writeSystemMessageInTx(tx, threadId, {
          type: 'FRIEND_ADDED',
        });
        throw new Error('relationship rollback');
      }),
    ).rejects.toThrow('relationship rollback');
    expect(await database.db.select().from(durableTask)).toEqual([]);
    expect(
      (
        await database.db.query.messageThread.findFirst({
          where: eq(messageThread.id, threadId),
        })
      )?.curSeq,
    ).toBe(0);
  });

  it.each([true, false])(
    'projects peer heads only while the pair is active (%s), even with a retained audience',
    async (active) => {
      const domain = `fanout-real-${active}.test`;
      const namespaceId = await seedFederatedPeerNamespace(database.db, domain);
      const [local] = await database.db
        .insert(account)
        .values({
          account: `fanout-local-${active}`,
          domain: 'local',
          updatedAt: new Date(),
        })
        .returning();
      await seedAcceptedRelationship(
        database.db,
        local.id,
        {
          account: 'remote',
          domain,
          namespaceId,
        },
        threadId,
      );
      await database.db.insert(threadAudience).values({
        threadId,
        targetDomain: domain,
        targetNamespaceId: namespaceId,
      });
      await database.db.insert(message).values({
        threadId,
        seq: 1,
        creatorAccount: local.account,
        creatorDomain: 'local',
        contentType: 'PURE_TEXT',
        content: '{"text":"hello"}',
        updatedAt: new Date(),
      });
      await database.db
        .update(messageThread)
        .set({ curSeq: 1 })
        .where(eq(messageThread.id, threadId));
      await messages.writeSystemMessage(threadId, { type: 'FRIEND_ADDED' });
      await enqueueBoth(2);
      const task = (await database.db.select().from(durableTask)).find(
        (row) => row.taskType === federationType,
      )!;
      const heads = new FederationThreadContentHeadService(
        new PeerStateFeedService(database),
      );
      const events = { emit: vi.fn() };
      const handler = new FederationThreadFanoutTaskHandler(
        database,
        new DurableTaskDispatcherService(),
        heads,
        events as never,
      );
      if (!active)
        await database.db
          .update(relationshipPair)
          .set({ active: false })
          .where(eq(relationshipPair.threadId, threadId));
      await handler.execute((await store.claim(task.id))!);
      const feed = await database.db
        .select()
        .from(peerStateFeed)
        .where(eq(peerStateFeed.namespaceId, namespaceId));
      expect(
        feed
          .filter((row) => row.eventType === 'THREAD_CONTENT_HEAD')
          .map((row) => row.body),
      ).toEqual(active ? [{ messageEndSeq: 1, tombstoneEndSeq: 0 }] : []);
      expect(events.emit).toHaveBeenCalledTimes(active ? 1 : 0);
    },
  );

  it('skips a hosted-group peer that only has a pending invitation audience', async () => {
    const domain = 'fanout-pending-group.test';
    const namespaceId = await seedFederatedPeerNamespace(database.db, domain);
    const [authoredGroup] = await database.db
      .insert(groupAccount)
      .values({ account: '!fanout-pending-group' })
      .returning();
    await database.db
      .update(messageThread)
      .set({
        type: 'GROUP',
        groupAccount: authoredGroup.account,
        groupDomain: 'local',
        groupAccountId: authoredGroup.id,
        authorityNamespaceId: 0,
      })
      .where(eq(messageThread.id, threadId));
    await database.db.insert(relationshipPair).values({
      kind: 'GROUP_MEMBER',
      endpointAType: 'GROUP',
      endpointAAccount: authoredGroup.account,
      endpointADomain: 'local',
      endpointANamespaceId: namespaceId,
      endpointBType: 'USER',
      endpointBAccount: 'pending-member',
      endpointBDomain: domain,
      endpointBNamespaceId: namespaceId,
      threadId,
      active: false,
    });
    await database.db.insert(threadAudience).values({
      threadId,
      targetDomain: domain,
      targetNamespaceId: namespaceId,
    });
    await enqueueBoth(1);
    const queued = (await database.db.select().from(durableTask)).find(
      (task) => task.taskType === federationType,
    )!;
    const events = { emit: vi.fn() };
    const handler = new FederationThreadFanoutTaskHandler(
      database,
      new DurableTaskDispatcherService(),
      new FederationThreadContentHeadService(
        new PeerStateFeedService(database),
      ),
      events as never,
    );

    await handler.execute((await store.claim(queued.id))!);

    expect(
      await database.db
        .select()
        .from(peerStateFeed)
        .where(eq(peerStateFeed.namespaceId, namespaceId)),
    ).toEqual([]);
    expect(events.emit).not.toHaveBeenCalled();
    expect(
      await database.db.query.durableTask.findFirst({
        where: eq(durableTask.id, queued.id),
      }),
    ).toMatchObject({ checkpoint: { phase: 'DONE', afterNamespaceId: 0 } });
  });

  it('merges pending watermarks by MAX', async () => {
    const first = await enqueue(5, 1);
    expect(await enqueue(4, 2)).toBe(first);
    const rows = await database.db.select().from(durableTask);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({
      threadId,
      messageEndSeq: 5,
      tombstoneEndSeq: 2,
      profileRev: 0,
    });
  });

  it('durably yields to a newer target while preserving both heads and resetting no successor cursor', async () => {
    const first = await enqueue(5, 3);
    await store.claim(first);
    expect(
      await progress.yieldToNewer(first, {
        threadId,
        messageEndSeq: 5,
        tombstoneEndSeq: 3,
      }),
    ).toBe(false);
    const next = await enqueue(6, 2);
    expect(
      await progress.yieldToNewer(first, {
        threadId,
        messageEndSeq: 5,
        tombstoneEndSeq: 3,
      }),
    ).toBe(true);
    const completed = await database.db.query.durableTask.findFirst({
      where: eq(durableTask.id, first),
    });
    expect(completed?.status).toBe('SUCCEEDED');
    expect(completed?.completedAt).not.toBeNull();
    expect(completed?.checkpoint).toEqual({ phase: 'DONE', afterAccountId: 0 });
    const successor = await database.db.query.durableTask.findFirst({
      where: eq(durableTask.id, next),
    });
    expect(successor?.payload).toEqual({
      threadId,
      messageEndSeq: 6,
      tombstoneEndSeq: 3,
      profileRev: 0,
    });
    expect(successor?.checkpoint).toEqual({});
    expect(
      (
        await store.findEligible([DurableTaskType.FAN_OUT_THREAD_CONTENT], 10)
      ).map((task) => task.id),
    ).toEqual([next]);
    // Ordinary scheduler finalization remains harmless after atomic completion.
    await store.markSucceeded(first);
    expect(
      (
        await store.findEligible([DurableTaskType.FAN_OUT_THREAD_CONTENT], 10)
      ).map((task) => task.id),
    ).toEqual([next]);
  });

  it('does not yield to an equal target or an unclaimed old task', async () => {
    const first = await enqueue(5, 3);
    await store.claim(first);
    const next = await enqueue(5, 3);
    expect(
      await progress.yieldToNewer(first, {
        threadId,
        messageEndSeq: 5,
        tombstoneEndSeq: 3,
      }),
    ).toBe(false);
    await store.markSucceeded(first);
    const trailing = await enqueue(6, 4);
    expect(trailing).toBe(next);
    expect(await progress.read(first).catch(() => null)).toBeNull();
  });

  it('does not change claimed work and preserves a merged trailing pending task', async () => {
    const first = await enqueue(1);
    expect(await store.claim(first)).toBeDefined();
    const second = await enqueue(2);
    expect(second).not.toBe(first);
    expect(await enqueue(3)).toBe(second);
    expect(
      (
        await database.db.query.durableTask.findFirst({
          where: eq(durableTask.id, first),
        })
      )?.payload.messageEndSeq,
    ).toBe(1);
    expect(
      await store.findEligible([DurableTaskType.FAN_OUT_THREAD_CONTENT], 10),
    ).toEqual([]);
    await store.markSucceeded(first);
    expect(
      (
        await store.findEligible([DurableTaskType.FAN_OUT_THREAD_CONTENT], 10)
      ).map((task) => task.id),
    ).toEqual([second]);
  });

  it('rolls back source state and task together', async () => {
    await expect(
      database.db.transaction(async (tx) => {
        const lock = (await acquireThreadContentLockInTx(tx, threadId))!;
        await tx
          .update(messageThread)
          .set({ curSeq: 1 })
          .where(eq(messageThread.id, threadId));
        await enqueueThreadFanoutInTx(tx, lock, {
          threadId,
          messageEndSeq: 1,
          tombstoneEndSeq: 0,
        });
        throw new Error('abort source');
      }),
    ).rejects.toThrow('abort source');
    expect(await database.db.select().from(durableTask)).toHaveLength(0);
    expect(
      (
        await database.db.query.messageThread.findFirst({
          where: eq(messageThread.id, threadId),
        })
      )?.curSeq,
    ).toBe(0);
  });

  it('serializes concurrent enqueue operations into one pending target', async () => {
    const ids = await Promise.all([3, 1, 5, 2, 4].map((seq) => enqueue(seq)));
    expect(new Set(ids).size).toBe(1);
    const [task] = await database.db.select().from(durableTask);
    expect(task.payload.messageEndSeq).toBe(5);
  });
});
