import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  accountThreadState,
  messageThread,
  relationshipPair,
} from '../src/database/schema.js';
import { SseService } from '../src/gateway/sse.service.js';
import { ThreadFeedService } from '../src/message/thread-feed.service.js';
import { DurableTaskDispatcherService } from '../src/durable-task/durable-task-dispatcher.service.js';
import { DurableTaskStoreService } from '../src/durable-task/durable-task-store.service.js';
import { ThreadPreviewService } from '../src/message/thread-preview.service.js';
import { AccountThreadStateService } from '../src/account-thread-state/account-thread-state.service.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';

/** Business commits publish through the shared SSE methods without polling. */
describe('account feed notification delivery', () => {
  const database = new DatabaseService();
  const sse = new SseService(database, { get: () => null } as never);
  const clientFeed = new ClientStateFeedService(database, sse);
  const feed = new ThreadFeedService(
    database,
    new DurableTaskDispatcherService(),
  );
  const tasks = new DurableTaskStoreService(database);
  const participants = new AccountThreadStateService(
    database,
    {} as never,
    clientFeed,
  );
  const hints = vi.spyOn(sse, 'onThreadFeedUpdated');
  const devices: string[][] = [[], []];
  let userId: number;
  let threadId: number;

  beforeAll(async () => {
    await database.onModuleInit();
    const [owner] = await database.db
      .insert(account)
      .values({ account: 'wake-reader' })
      .returning();
    userId = owner.id;
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', curSeq: 10, updatedAt: new Date() })
      .returning();
    threadId = thread.id;
    await database.db.insert(relationshipPair).values({
      kind: 'P2P',
      active: true,
      threadId,
      endpointAType: 'USER',
      endpointAAccount: 'peer',
      endpointADomain: 'local',
      endpointANamespaceId: 0,
      endpointBType: 'USER',
      endpointBAccount: 'wake-reader',
      endpointBDomain: 'local',
      endpointBNamespaceId: 0,
      updatedAt: new Date(),
    });
    await database.db.insert(accountThreadState).values({
      accountId: userId,
      threadId,
      messageEndSeq: 10,
      updatedAt: new Date(),
    });
    Object.assign(feed, { previews: new ThreadPreviewService(database), sse });
    Object.assign(participants, {
      previews: new ThreadPreviewService(database),
    });
    for (const [index, writes] of devices.entries()) {
      sse.register(userId, index + 1, {
        writeHead: vi.fn(),
        write: (frame: string) => {
          writes.push(frame);
          return true;
        },
        on: vi.fn(),
        end: vi.fn(),
      } as unknown as ServerResponse);
    }
    await vi.waitFor(() => {
      for (const writes of devices)
        expect(writes.some((w) => w.includes('event: HELLO'))).toBe(true);
    });
    hints.mockClear();
  });
  afterAll(async () => {
    clientFeed.onModuleDestroy();
    sse.onModuleDestroy();
    await database.onApplicationShutdown();
  });

  async function heads() {
    return (await database.db.query.account.findFirst({
      where: eq(account.id, userId),
    }))!;
  }
  async function expectDelivered(event: string, field: string, head: number) {
    await vi.waitFor(
      () => {
        for (const writes of devices)
          expect(
            writes.some(
              (frame) =>
                frame.includes(`event: ${event}\n`) &&
                frame.includes(`"${field}":${head}}`),
            ),
          ).toBe(true);
      },
      { timeout: 4000, interval: 20 },
    );
  }

  it('delivers read-position task changes to both connected devices without a new message', async () => {
    const before = await heads();
    const admitted = await feed.enqueueReadPosition(userId, {
      threadId,
      localReadHwm: 4,
    });
    const task = await tasks.claim(BigInt(admitted.taskId));
    expect(task).toBeTruthy();
    await feed.executeTask(task!);
    const after = await heads();
    expect(after.threadFeedEndId).toBeGreaterThan(before.threadFeedEndId);
    await expectDelivered(
      'THREAD_FEED_UPDATED',
      'threadFeedEndId',
      after.threadFeedEndId,
    );
    const state = await database.db.query.accountThreadState.findFirst({
      where: eq(accountThreadState.accountId, userId),
    });
    expect(state?.lastReadSeq).toBe(4);
  });

  it('delivers both heads changed by blocking and resetting the read window', async () => {
    await participants.setBlocked(userId, threadId, true);
    const blocked = await heads();
    await expectDelivered(
      'STATE_FEED_UPDATED',
      'feedId',
      blocked.stateFeedEndId,
    );
    await participants.setBlocked(userId, threadId, false);
    const unblocked = await heads();
    expect(unblocked.threadFeedEndId).toBeGreaterThan(blocked.threadFeedEndId);
    expect(unblocked.stateFeedEndId).toBeGreaterThan(blocked.stateFeedEndId);
    await expectDelivered(
      'THREAD_FEED_UPDATED',
      'threadFeedEndId',
      unblocked.threadFeedEndId,
    );
    await expectDelivered(
      'STATE_FEED_UPDATED',
      'feedId',
      unblocked.stateFeedEndId,
    );
  });

  it('does not notify or change heads when a business transaction rolls back', async () => {
    hints.mockClear();
    const before = await heads();
    const transaction = database.db.transaction.bind(database.db);
    const mocked = vi
      .spyOn(database.db, 'transaction')
      .mockImplementation((run, config) =>
        transaction(async (tx) => {
          await run(tx);
          expect(hints).not.toHaveBeenCalled();
          throw new Error('abort business transaction');
        }, config),
      );
    try {
      await expect(
        participants.setBlocked(userId, threadId, true),
      ).rejects.toThrow('abort business transaction');
      expect(hints).not.toHaveBeenCalled();
      expect(await heads()).toEqual(before);
    } finally {
      mocked.mockRestore();
    }
  });
});
