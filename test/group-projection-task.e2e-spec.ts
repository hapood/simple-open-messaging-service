import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  durableTask,
  federatedPeer,
  group,
  groupMetaFeed,
  messageThread,
  peerStateFeed,
  peerStateFeedTarget,
  threadAudience,
  user,
} from '../src/database/schema.js';
import type { DurableTask } from '../src/durable-task/durable-task.types.js';
import { FEDERATION_STATE_FEED_PUSH } from '../src/federation/federation-state-feed.events.js';
import { GroupProjectionTaskExecutionService } from '../src/federation/group-projection-task-execution.service.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import { seedFederatedPeerNamespace } from './seed.js';

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
      .insert(user)
      .values({
        account: `projection-local-${suffix}`,
        domain: 'local',
        name: 'Local member',
        updatedAt: new Date(),
      })
      .returning({ id: user.id });
    localUserId = localIdentity.id;
    await database.db.insert(account).values({ id: localUserId });

    const [createdGroup] = await database.db
      .insert(group)
      .values({
        account: groupAccount,
        domain: 'local',
        name: 'Projection Group',
        updatedAt: new Date(),
      })
      .returning({ id: group.id });
    groupId = createdGroup.id;
    await database.db.insert(groupMetaFeed).values({ groupId, feedEndId: 12n });
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'GROUP', groupId, updatedAt: new Date() })
      .returning({ id: messageThread.id });
    threadId = thread.id;
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
    await database.db.delete(user).where(eq(user.id, localUserId));
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
  });

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
