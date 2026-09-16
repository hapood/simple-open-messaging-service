import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
  vi,
} from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { DatabaseService } from '../src/database/database.service';
import { message, messageThread } from '../src/database/schema';
import { ContentType } from '../src/database/enums.js';
import { ThreadFeedHeadWriter } from '../src/message/thread-feed-head.writer.js';
import { requireThreadContentLockInTx } from '../src/common/business/locks/thread-content-lock.js';
import { seedAcceptedRelationship, seedUser, seedSession } from './seed';
import { createTestApp } from './support/app';
import { truncateTablesForTest } from './support/truncate';

/**
 * ClientStateFeed + /notification-feed/query e2e:
 *  - state feed: the sole device-facing compacted feed, including paired thread content heads.
 *  - notification-feed query: one descriptor per conversation. Message mode includes a bounded
 *    recent-message sample; private mode omits content entirely.
 *
 * The BigInt message `id` is NEVER exposed — only per-thread `seq` + time. Three P2P threads seeded in
 * insertion order (Alice → Bob → Carol) so message ids strictly increase → deterministic.
 */
describe('client state feed + notification feed', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let sessionToken: string;
  let recipientId: number;
  let tAlice: number;
  let tBob: number;
  let tCarol: number;
  const base = Date.UTC(2026, 0, 1);

  beforeAll(async () => {
    ({ app, database } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    // Let committed background work finish before the next fixture truncates its tables.
    await vi.waitFor(
      async () => {
        const result = await database.pool.query(`
        SELECT count(*)::integer AS count FROM "DurableTask"
        WHERE status IN ('PENDING', 'PROCESSING')
      `);
        expect(result.rows[0].count).toBe(0);
      },
      { timeout: 15000 },
    );
  });

  beforeEach(async () => {
    await truncateTablesForTest(database.pool, 'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread" RESTART IDENTITY CASCADE');
    const recipient = await seedUser(app, 'recip', { name: 'Recip' });
    recipientId = recipient.id;
    sessionToken = await seedSession(app, recipientId, 'app');
    tAlice = await seedThread({ name: 'Alice' });
    tBob = await seedThread({ name: 'Bob' });
    tCarol = await seedThread({ name: 'Carol' });
  });

  /** Seed one P2P thread: 3 messages (seq 1..3) from a fresh peer. */
  async function seedThread(opts: { name: string }): Promise<number> {
    const now = new Date();
    const peer = await seedUser(app, opts.name.toLowerCase(), {
      name: opts.name,
    });
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'P2P',
        curSeq: 3,
        updatedAt: now,
      })
      .returning({ id: messageThread.id });
    await seedAcceptedRelationship(
      database.db,
      recipientId,
      peer.id,
      thread.id,
    );
    await database.db.insert(message).values(
      Array.from({ length: 3 }, (_, index) => ({
        threadId: thread.id,
        seq: index + 1,
        originSeq: index + 1,
        contentType: ContentType.PURE_TEXT,
        content: JSON.stringify({ text: `${opts.name}-${index}` }),
        creatorAccount: opts.name.toLowerCase(),
        creatorDomain: 'local',
        profileRev: 1,
        createdAt: new Date(base + index),
        updatedAt: now,
      })),
    );
    await database.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, thread.id);
      await ThreadFeedHeadWriter.advanceInTx(tx, recipientId, {
        threadId: thread.id,
        messageEndSeq: 3,
        tombstoneEndSeq: 0,
      });
    });
    return thread.id;
  }

  function getState(params: Record<string, string | number>) {
    return request(app.getHttpServer())
      .get('/api/v1/user/state-feed')
      .set('Authorization', `Bearer ${sessionToken}`)
      .query(params);
  }

  function getThreads(body: Record<string, number> = { after: 0 }) {
    return request(app.getHttpServer())
      .post('/api/v1/thread/feed-delta')
      .set('Authorization', 'Bearer ' + sessionToken)
      .send(body);
  }

  it('returns content heads and unread state together, outside state feed', async () => {
    const response = await getThreads();
    expect(response.body.code).toBe(0);
    const rows = response.body.data.items;
    expect(rows.map((row: { threadId: number }) => row.threadId)).toEqual(
      expect.arrayContaining([tAlice, tBob, tCarol]),
    );
    expect(
      rows.find((row: { threadId: number }) => row.threadId === tAlice),
    ).toMatchObject({
      messageEndSeq: 3,
      tombstoneEndSeq: 0,
      unreadCount: 3,
      lastReadSeq: 0,
    });
    const state = await getState({ after: 0, take: 200, mode: 'full' });
    expect(
      state.body.data.items.some(
        (row: { eventType: string }) => row.eventType === 'THREAD_CONTENT_HEAD',
      ),
    ).toBe(false);
  });

  it('consumes every changed thread in feed order and advances empty ranges', async () => {
    const first = (await getThreads({ after: 0, take: 1 })).body.data;
    expect(first.hasMore).toBe(true);
    let cursor = first.scannedThrough;
    const ids = [first.items[0].threadId];
    while (cursor < first.through) {
      const page = (
        await getThreads({ after: cursor, through: first.through, take: 1 })
      ).body.data;
      expect(page.scannedThrough).toBeGreaterThan(cursor);
      ids.push(...page.items.map((row: { threadId: number }) => row.threadId));
      cursor = page.scannedThrough;
    }
    expect(new Set(ids).size).toBe(3);
    const empty = (await getThreads({ after: cursor, through: cursor })).body
      .data;
    expect(empty).toMatchObject({
      items: [],
      hasMore: false,
      scannedThrough: cursor,
    });
  });

  it('returns bounded in-memory previews and validates the configured maximum', async () => {
    const single = await getThreads({ after: 0, previewCount: 1 });
    expect(single.body.code).toBe(0);
    expect(single.body.data.items[0].previews).toEqual([
      expect.objectContaining({ seq: 3, status: 'LIVE' }),
    ]);
    const full = await getThreads({ after: 0, previewCount: 5 });
    expect(
      full.body.data.items[0].previews.map((item: { seq: number }) => item.seq),
    ).toEqual([1, 2, 3]);
    const invalid = await getThreads({ after: 0, previewCount: 6 });
    expect(invalid.status).toBe(200);
    expect(invalid.body.code).toBe(10000);
  });

  it('removes attention-delta without a compatibility route', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/thread/attention-delta')
      .set('Authorization', 'Bearer ' + sessionToken)
      .send({ after: 0 });
    expect(response.body.code).not.toBe(0);
    expect(response.body.data).toBeFalsy();
  });
});
