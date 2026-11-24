import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { MessageEvent } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { Subscription } from 'rxjs';
import { MessageHistoryIntervalController } from '../src/controller/message-history-interval.controller.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  accountThreadState,
  federationThreadHistoryGap,
  messageThread,
} from '../src/database/schema.js';
import { FederationThreadRoundSchedulerService } from '../src/federation/federation-thread-round-scheduler.service.js';
import { HistoryIntervalEventsService } from '../src/message/history-interval-events.service.js';
import { seedFederatedPeerNamespace, seedUser } from './seed.js';
import { createTestApp } from './support/app.js';

/** Real visibility and gap queries; only federation execution is replaced. */
describe('message history interval subscriptions (PostgreSQL)', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let controller: MessageHistoryIntervalController;
  let events: HistoryIntervalEventsService;
  let viewerId: number;
  let peerNamespaceId: number;
  let otherNamespaceId: number;
  const onWake = vi.fn();
  const subscriptions: Subscription[] = [];

  beforeAll(async () => {
    ({ app, database } = await createTestApp((builder) => {
      builder
        .overrideProvider(FederationThreadRoundSchedulerService)
        .useValue({ onWake });
    }));
    controller = app.get(MessageHistoryIntervalController);
    events = app.get(HistoryIntervalEventsService);
    viewerId = (await seedUser(app, 'interval-viewer')).id;
    peerNamespaceId = await seedFederatedPeerNamespace(
      database.db,
      'interval-peer.test',
    );
    otherNamespaceId = await seedFederatedPeerNamespace(
      database.db,
      'interval-other.test',
    );
  });

  afterEach(() => {
    for (const subscription of subscriptions.splice(0))
      subscription.unsubscribe();
    onWake.mockClear();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function seedThread(
    type: 'P2P' | 'GROUP' = 'P2P',
    authorityNamespaceId = 0,
  ) {
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type,
        authorityNamespaceId,
        groupAccount: type === 'GROUP' ? '!interval-mirror' : null,
        curSeq: 120,
        clearedSeq: 90,
        federationRoundsEnabled: true,
        updatedAt: new Date(),
      })
      .returning();
    await database.db.insert(accountThreadState).values({
      accountId: viewerId,
      threadId: thread.id,
    });
    return thread.id;
  }

  function viewerWhere(threadId: number) {
    return and(
      eq(accountThreadState.accountId, viewerId),
      eq(accountThreadState.threadId, threadId),
    );
  }

  async function open(threadId: number) {
    return controller.historyInterval(
      { user: { userId: viewerId } } as FastifyRequest,
      { threadId, left: 80, right: 150 },
    );
  }

  function collect(stream: Awaited<ReturnType<typeof open>>) {
    const frames: MessageEvent[] = [];
    const errors: unknown[] = [];
    const subscription = stream.subscribe({
      next: (frame) => {
        if (frame.type === 'MESSAGE_HISTORY_INTERVAL') frames.push(frame);
      },
      error: (error: unknown) => errors.push(error),
    });
    subscriptions.push(subscription);
    return { frames, errors, subscription };
  }

  it('clips real viewer bounds, revalidates a committed departure boundary, and closes on lost access', async () => {
    const threadId = await seedThread();
    const observed = collect(await open(threadId));
    await vi.waitFor(() =>
      expect(observed.frames).toEqual([
        {
          type: 'MESSAGE_HISTORY_INTERVAL',
          data: { threadId, left: 90, right: 120 },
        },
      ]),
    );

    // These are the persisted read boundaries used by retained conversations
    // after departure. The listener must reread them, not cache initial access.
    await database.db.transaction(async (tx) => {
      await tx
        .update(messageThread)
        .set({ clearedSeq: 95 })
        .where(eq(messageThread.id, threadId));
      await tx
        .update(accountThreadState)
        .set({ messageVisibleThroughSeq: 105 })
        .where(viewerWhere(threadId));
    });
    events.publishCommitted({ threadId, left: 90, right: 130 });
    await vi.waitFor(() => expect(observed.frames).toHaveLength(2));
    expect(observed.frames[1]).toEqual({
      type: 'MESSAGE_HISTORY_INTERVAL',
      data: { threadId, left: 95, right: 105 },
    });

    // A forbidden interval precedes a visible marker in the serialized stream,
    // so observing the marker proves the former was processed without leaking.
    events.publishCommitted({ threadId, left: 105, right: 120 });
    events.publishCommitted({ threadId, left: 100, right: 101 });
    await vi.waitFor(() => expect(observed.frames).toHaveLength(3));
    expect(observed.frames[2].data).toEqual({
      threadId,
      left: 100,
      right: 101,
    });

    await database.db.delete(accountThreadState).where(viewerWhere(threadId));
    events.publishCommitted({ threadId, left: 100, right: 102 });
    await vi.waitFor(() => expect(observed.subscription.closed).toBe(true));
    expect(observed.frames).toHaveLength(3);
    expect(observed.errors).toEqual([]);
    expect(events.hasObservers(threadId)).toBe(false);
    // Exact frame equality above also forbids messages, publisher coordinates,
    // or other data from crossing the public SSE boundary.
  });

  it.each(['P2P', 'GROUP'] as const)(
    'maps %s publisher gaps into the mounted local interval and wakes only eligible sources',
    async (type) => {
      const threadId = await seedThread(
        type,
        type === 'P2P' ? 0 : peerNamespaceId,
      );
      await database.db.insert(federationThreadHistoryGap).values([
        {
          threadId,
          namespaceId: peerNamespaceId,
          startSeq: 1,
          endSeq: 10,
          messageSeqOffset: 100,
        },
        {
          threadId,
          namespaceId: peerNamespaceId,
          startSeq: 11,
          endSeq: 20,
          messageSeqOffset: 100,
        },
        // For a mirror this is not its authority; for P2P this local range
        // (200, 210] does not intersect the subscription.
        {
          threadId,
          namespaceId: otherNamespaceId,
          startSeq: 1,
          endSeq: 10,
          messageSeqOffset: type === 'GROUP' ? 100 : 200,
        },
      ]);
      const observed = collect(await open(threadId));
      events.publishCommitted({ threadId, left: 100, right: 101 });
      // The queued marker is processed after the initial gap query and wakes.
      await vi.waitFor(() => expect(observed.frames).toHaveLength(2));
      expect(onWake).toHaveBeenCalledExactlyOnceWith({
        threadId,
        namespaceId: peerNamespaceId,
        mode: 'thread',
      });
      expect(observed.errors).toEqual([]);
      observed.subscription.unsubscribe();
      expect(events.hasObservers(threadId)).toBe(false);
    },
  );

  it('registers before the initial PostgreSQL read and retains a notification racing that read', async () => {
    const threadId = await seedThread();
    const stream = await open(threadId);
    const locker = await database.pool.connect();
    try {
      await locker.query('BEGIN');
      // A table lock makes the MVCC SELECT wait without replacing any query or
      // introducing a timing sleep. Release it before waiting for SSE frames.
      await locker.query(
        'LOCK TABLE "AccountThreadState" IN ACCESS EXCLUSIVE MODE',
      );
      const {
        rows: [{ pid }],
      } = await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const observed = collect(stream);
      expect(events.hasObservers(threadId)).toBe(true);
      await vi.waitFor(async () => {
        const { rows } = await database.pool.query<{ waiting: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))) AS waiting',
          [pid],
        );
        expect(rows[0].waiting).toBe(true);
      });
      expect(observed.frames).toEqual([]);
      events.publishCommitted({ threadId, left: 100, right: 110 });
      await locker.query('COMMIT');
      await vi.waitFor(() =>
        expect(observed.frames).toEqual([
          {
            type: 'MESSAGE_HISTORY_INTERVAL',
            data: { threadId, left: 90, right: 120 },
          },
          {
            type: 'MESSAGE_HISTORY_INTERVAL',
            data: { threadId, left: 100, right: 110 },
          },
        ]),
      );
      expect(observed.errors).toEqual([]);
      observed.subscription.unsubscribe();
      expect(events.hasObservers(threadId)).toBe(false);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
  });
});
