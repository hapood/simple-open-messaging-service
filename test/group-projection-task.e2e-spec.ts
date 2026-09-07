import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  durableTask,
  federatedPeer,
  groupAccount as group,
  groupMetaFeed,
  messageThread,
  peerStateFeed,
  peerStateFeedTarget,
  threadAudience,
} from '../src/database/schema.js';
import type { DurableTask } from '../src/durable-task/durable-task.types.js';
import { FEDERATION_STATE_FEED_PUSH } from '../src/federation/federation-state-feed.events.js';
import { GroupProjectionTaskExecutionService } from '../src/federation/group-projection-task-execution.service.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { lockBusinessAccountsInTx } from '../src/relationship/business-scope-lock.js';

describe('Group Meta head fan-out task execution', () => {
  const suffix = Date.now().toString(36);
  const peerDomain = `projection-${suffix}.test`;
  const groupAccount = `!projection${suffix}`;
  let mod: TestingModule;
  let database: DatabaseService;
  let execution: GroupProjectionTaskExecutionService;
  let peerNamespaceId: number;
  let groupId: number;
  let threadId: number;
  let localUserId: number;
  let lastAudienceId: bigint;

  const clientStateFeed = {
    notifyFeedUpdates: vi.fn(),
    writeInTx: vi.fn().mockResolvedValue(17),
  };
  const events = { emit: vi.fn() };

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        GroupProjectionTaskExecutionService,
        PeerStateFeedService,
        { provide: ClientStateFeedService, useValue: clientStateFeed },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();
    database = mod.get(DatabaseService);
    execution = mod.get(GroupProjectionTaskExecutionService);
    peerNamespaceId = await seedFederatedPeerNamespace(database.db, peerDomain);

    const [localIdentity] = await database.db
      .insert(account)
      .values({
        account: `projection-local-${suffix}`,
        domain: 'local',
        updatedAt: new Date(),
      })
      .returning({ id: account.id });
    localUserId = localIdentity.id;

    const [createdGroup] = await database.db
      .insert(group)
      .values({
        account: groupAccount,
        updatedAt: new Date(),
      })
      .returning({ id: group.id });
    groupId = createdGroup.id;
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'GROUP',
        groupAccount,
        groupDomain: 'local',
        groupAccountId: groupId,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await database.db
      .insert(groupMetaFeed)
      .values({ threadId, feedEndId: 12n });
    const audiences = await database.db
      .insert(threadAudience)
      .values([
        {
          targetDomain: 'local',
          targetNamespaceId: 0,
          localUserId,
          threadId,
        },
        {
          targetDomain: peerDomain,
          targetNamespaceId: peerNamespaceId,
          threadId,
        },
      ])
      .returning({ id: threadAudience.id });
    lastAudienceId = audiences.at(-1)!.id;
  });

  afterAll(async () => {
    await database.db
      .delete(durableTask)
      .where(eq(durableTask.scopeKey, projectionScopeKey()));
    await database.db
      .delete(peerStateFeed)
      .where(eq(peerStateFeed.namespaceId, peerNamespaceId));
    await database.db
      .delete(peerStateFeedTarget)
      .where(eq(peerStateFeedTarget.namespaceId, peerNamespaceId));
    await database.db
      .delete(threadAudience)
      .where(eq(threadAudience.threadId, threadId));
    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId));
    await database.db.delete(group).where(eq(group.id, groupId));
    await database.db.delete(account).where(eq(account.id, localUserId));
    await database.db
      .delete(federatedPeer)
      .where(eq(federatedPeer.domain, peerDomain));
    await mod.close();
  });

  it('publishes the shared canonical head once to each current audience', async () => {
    const task = await insertProcessingTask();

    await execution.execute(task, { threadId });

    await expect(readCheckpoint(task.id)).resolves.toEqual({
      afterAudienceId: lastAudienceId.toString(),
    });
    expect(clientStateFeed.writeInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: localUserId,
        account: groupAccount,
        eventType: 'GROUP_META_FEED_HEAD',
        body: { groupMetaFeedEndId: '12' },
      }),
    );
    expect(clientStateFeed.notifyFeedUpdates).toHaveBeenCalledWith([
      { userId: localUserId, feedId: 17 },
    ]);
    const [published] = await database.db
      .select({ body: peerStateFeed.body })
      .from(peerStateFeed)
      .where(
        and(
          eq(peerStateFeed.namespaceId, peerNamespaceId),
          eq(peerStateFeed.eventType, 'GROUP_META_FEED_HEAD'),
          eq(peerStateFeed.account, groupAccount),
        ),
      );
    expect(published?.body).toEqual({ groupMetaFeedEndId: '12' });
    expect(events.emit).toHaveBeenCalledWith(FEDERATION_STATE_FEED_PUSH, {
      peerDomain,
    });
    await database.db
      .update(durableTask)
      .set({ status: 'SUCCEEDED', completedAt: new Date() })
      .where(eq(durableTask.id, task.id));
  });

  it('serializes fan-out with a departure before locking audiences or client allocators', async () => {
    const task = await insertProcessingTask();
    // Exercise the real client allocator; the notification transport is not involved.
    clientStateFeed.writeInTx.mockImplementation(async (tx, write) => {
      const [owner] = await tx
        .update(account)
        .set({
          stateFeedAllocatedThrough: sql`${account.stateFeedAllocatedThrough} + 1`,
        })
        .where(eq(account.id, write.userId))
        .returning();
      return owner.stateFeedAllocatedThrough;
    });
    let fanout: Promise<unknown> | undefined;
    try {
      await database.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
        // The departure has already written its manager-facing request projection.
        await lockBusinessAccountsInTx(tx, [
          { account: groupAccount, domain: 'local' },
        ]);
        await tx
          .update(account)
          .set({
            stateFeedAllocatedThrough: sql`${account.stateFeedAllocatedThrough} + 1`,
          })
          .where(eq(account.id, localUserId));
        const pid = await tx.execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        fanout = execution.execute(task, { threadId }).then(
          () => null,
          (error: unknown) => error,
        );
        // Observe an actual database wait, not an arbitrary scheduling delay. Before
        // the fix fan-out holds the audience and waits for Account; after it waits
        // for the group scope without holding any audience rows.
        await vi.waitFor(
          async () => {
            const waiting = await database.pool.query(
              'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))',
              [pid.rows[0].pid],
            );
            expect(waiting.rows.length).toBeGreaterThan(0);
          },
          { timeout: 3000, interval: 20 },
        );
        await tx
          .delete(threadAudience)
          .where(
            and(
              eq(threadAudience.threadId, threadId),
              eq(threadAudience.targetDomain, peerDomain),
            ),
          );
        await tx
          .update(groupMetaFeed)
          .set({ feedEndId: 13n })
          .where(eq(groupMetaFeed.threadId, threadId));
      });
      expect(await fanout).toBeNull();
      expect(
        await database.db.query.threadAudience.findFirst({
          where: and(
            eq(threadAudience.threadId, threadId),
            eq(threadAudience.targetDomain, peerDomain),
          ),
        }),
      ).toBeUndefined();
      expect(clientStateFeed.writeInTx).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: { groupMetaFeedEndId: '13' },
        }),
      );
    } finally {
      await fanout;
      clientStateFeed.writeInTx.mockReset().mockResolvedValue(17);
    }
  }, 15_000);

  async function insertProcessingTask(): Promise<DurableTask> {
    const now = new Date();
    const [task] = await database.db
      .insert(durableTask)
      .values({
        kind: 'PROJECTION',
        scopeType: 'GROUP',
        scopeKey: projectionScopeKey(),
        taskType: 'FAN_OUT_GROUP_META_HEAD',
        payload: { threadId },
        checkpoint: { afterAudienceId: '0' },
        coalescingKey: JSON.stringify(['FAN_OUT_GROUP_META_HEAD', threadId]),
        status: 'PROCESSING',
        createdAt: now,
        startedAt: now,
      })
      .returning();
    return task;
  }

  async function readCheckpoint(taskId: bigint) {
    const row = await database.db.query.durableTask.findFirst({
      where: eq(durableTask.id, taskId),
      columns: { checkpoint: true },
    });
    return row?.checkpoint;
  }

  function projectionScopeKey(): string {
    return JSON.stringify(['test-group-projection', groupAccount]);
  }
});
