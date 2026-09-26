import type { Subscription } from 'rxjs';
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
import { ThreadReadPositionService } from '../src/message/thread-read-position.service.js';
import { ThreadPreviewService } from '../src/message/thread-preview.service.js';
import { AccountThreadStateService } from '../src/account-thread-state/account-thread-state.service.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';

/** Business commits publish through the shared SSE methods without polling. */
describe('account feed notification delivery', () => {
  const database = new DatabaseService();
  const sse = new SseService(database, { get: () => null } as never);
  const clientFeed = new ClientStateFeedService(database, sse);
  const feed = new ThreadFeedService(database);
  const readPositions = new ThreadReadPositionService(database, sse);
  const participants = new AccountThreadStateService(database, clientFeed);
  const hints = vi.spyOn(sse, 'onThreadFeedUpdated');
  const devices: { type: string; data: Record<string, unknown> }[][] = [[], []];
  const subscriptions: Subscription[] = [];
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
    Object.assign(feed, { previews: new ThreadPreviewService(database) });
    Object.assign(participants, {
      sse,
      previews: new ThreadPreviewService(database),
    });
    for (const [index, writes] of devices.entries()) {
      subscriptions.push(
        sse.register(userId, index + 1).subscribe((event) => {
          writes.push({
            type: event.type,
            data: event.data as Record<string, unknown>,
          });
        }),
      );
    }
    await vi.waitFor(() => {
      for (const writes of devices)
        expect(writes.some((event) => event.type === 'HELLO')).toBe(true);
    });
    hints.mockClear();
  });
  afterAll(async () => {
    for (const subscription of subscriptions) subscription.unsubscribe();
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
              (frame) => frame.type === event && frame.data[field] === head,
            ),
          ).toBe(true);
      },
      { timeout: 4000, interval: 20 },
    );
  }

  it('delivers read-position changes to both connected devices without a new message', async () => {
    const before = await heads();
    await readPositions.execute(userId, {
      threadId,
      localReadHwm: 4,
    });
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

  it('delivers thread-feed changes from blocking and resetting the read window', async () => {
    const before = await heads();
    await participants.setBlocked(userId, threadId, true);
    const blocked = await heads();
    expect(blocked.threadFeedEndId).toBeGreaterThan(before.threadFeedEndId);
    expect(blocked.clientStateFeedEndId).toBe(before.clientStateFeedEndId);
    await expectDelivered(
      'THREAD_FEED_UPDATED',
      'threadFeedEndId',
      blocked.threadFeedEndId,
    );
    await participants.setBlocked(userId, threadId, false);
    const unblocked = await heads();
    expect(unblocked.threadFeedEndId).toBeGreaterThan(blocked.threadFeedEndId);
    expect(unblocked.clientStateFeedEndId).toBe(blocked.clientStateFeedEndId);
    await expectDelivered(
      'THREAD_FEED_UPDATED',
      'threadFeedEndId',
      unblocked.threadFeedEndId,
    );
  });

  it('publishes normalized private aliases to both devices and recovers them from the feed', async () => {
    const before = await heads();
    const saved = await participants.setAlias(
      userId,
      threadId,
      '  Work friend  ',
    );
    expect(saved).toEqual({
      threadId,
      alias: 'Work friend',
      threadFeedId: before.threadFeedEndId + 1,
    });
    await expectDelivered(
      'THREAD_FEED_UPDATED',
      'threadFeedEndId',
      saved.threadFeedId,
    );
    const delta = await feed.queryThreadFeedDelta(userId, {
      after: before.threadFeedEndId,
    });
    expect(delta.items).toEqual([expect.objectContaining(saved)]);
    const cold = await feed.queryThreadFeedDelta(userId, { after: 0 });
    expect(cold.items).toContainEqual(expect.objectContaining(saved));
    hints.mockClear();
    expect(
      await participants.setAlias(userId, threadId, 'Work friend'),
    ).toEqual(saved);
    expect(hints).not.toHaveBeenCalled();
    const cleared = await participants.setAlias(userId, threadId, '   ');
    expect(cleared.alias).toBeNull();
    expect(cleared.threadFeedId).toBe(saved.threadFeedId + 1);
    expect(
      (await feed.queryThreadFeedDelta(userId, { after: saved.threadFeedId }))
        .items,
    ).toEqual([expect.objectContaining(cleared)]);
    expect((await heads()).clientStateFeedEndId).toBe(
      before.clientStateFeedEndId,
    );
  });

  it('isolates private labels and serializes concurrent edits', async () => {
    const [other] = await database.db
      .insert(account)
      .values({ account: 'alias-other' })
      .returning();
    await database.db
      .insert(accountThreadState)
      .values({ accountId: other.id, threadId, updatedAt: new Date() });
    const results = await Promise.all([
      participants.setAlias(userId, threadId, 'First'),
      participants.setAlias(userId, threadId, 'Second'),
    ]);
    const latest = results.sort((a, b) => b.threadFeedId - a.threadFeedId)[0];
    expect(
      (
        await feed.queryThreadFeedDelta(userId, {
          after: latest.threadFeedId - 1,
        })
      ).items,
    ).toEqual([expect.objectContaining(latest)]);
    expect(
      await database.db.query.accountThreadState.findFirst({
        where: eq(accountThreadState.accountId, other.id),
        columns: { alias: true },
      }),
    ).toMatchObject({ alias: null });
  });

  it('never publishes an alias from a rolled back transaction', async () => {
    hints.mockClear();
    const before = await heads();
    const transaction = database.db.transaction.bind(database.db);
    const mocked = vi
      .spyOn(database.db, 'transaction')
      .mockImplementation((run, config) =>
        transaction(async (tx) => {
          await run(tx);
          expect(hints).not.toHaveBeenCalled();
          throw new Error('abort alias');
        }, config),
      );
    try {
      await expect(
        participants.setAlias(userId, threadId, 'Rolled back'),
      ).rejects.toThrow('abort alias');
      expect(await heads()).toEqual(before);
      expect(hints).not.toHaveBeenCalled();
    } finally {
      mocked.mockRestore();
    }
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
