import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/database/database.service';
import {
  message,
  messageThread,
  threadParticipant,
  user,
} from '../src/database/schema';
import { ContentType } from '../src/database/enums.js';
import { BusinessCode } from '../src/common/business-code.js';
import { ClientMessageFeedWriter } from '../src/message/client-message-feed.service.js';
import { seedAcceptedRelationship, seedUser, seedSession } from './seed';

/**
 * /thread-sync/catch-up + /notification-feed/query e2e — the two separated domain endpoints:
 *  - catch-up: the `(after, through]` walk of the per-user compacted message feed.
 *  - notification-feed query: one descriptor per conversation. Message mode includes a bounded
 *    recent-message sample; private mode omits content entirely.
 *
 * The BigInt message `id` is NEVER exposed — only per-thread `seq` + time. Three P2P threads seeded in
 * insertion order (Alice → Bob → Carol) so message ids strictly increase → deterministic.
 */
describe('thread catch-up + notification feed', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let sessionToken: string;
  let recipientId: number;
  let tAlice: number;
  let tBob: number;
  let tCarol: number;
  const base = Date.UTC(2026, 0, 1);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
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
    const [peer] = await database.db
      .insert(user)
      .values({
        account: opts.name.toLowerCase(),
        hashPwd: 'x',
        name: opts.name,
        updatedAt: now,
      })
      .returning({ id: user.id });
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'P2P',
        curSeq: 3,
        lastMessageSeq: 3,
        lastMessageAt: new Date(base + opts.name.length),
        updatedAt: now,
      })
      .returning({ id: messageThread.id });
    await database.db.insert(threadParticipant).values([
      { userId: recipientId, threadId: thread.id, updatedAt: now },
      { userId: peer.id, threadId: thread.id, updatedAt: now },
    ]);
    await seedAcceptedRelationship(database.db, recipientId, peer.id);
    await database.db.insert(message).values(
      Array.from({ length: 3 }, (_, index) => ({
        threadId: thread.id,
        seq: index + 1,
        originSeq: index + 1,
        contentType: ContentType.PURE_TEXT,
        content: JSON.stringify({ text: `${opts.name}-${index}` }),
        creator: peer.id,
        createdAt: new Date(base + index),
        updatedAt: now,
      })),
    );
    await database.db.transaction((tx) =>
      ClientMessageFeedWriter.publishMessage(tx, thread.id, 3, peer.id),
    );
    return thread.id;
  }

  function getSummary(params: Record<string, string | number>) {
    return request(app.getHttpServer())
      .get('/api/v1/thread-sync/catch-up')
      .set('Authorization', `Bearer ${sessionToken}`)
      .query(params);
  }

  function postMissed(
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    return request(app.getHttpServer())
      .post('/api/v1/notification-feed/query')
      .set('Authorization', `Bearer ${sessionToken}`)
      .set(headers)
      .send(body);
  }

  // ── /thread-sync/catch-up ───────────────────────────────────────────────────────────────────

  it('catch-up returns feed changes in ascending feed order', async () => {
    // from = Alice's latest, to = Carol's latest → range = Bob + Carol (Alice's latest is the lower bound).
    const res = await getSummary({
      after: 1,
      through: 3,
      take: 50,
    });
    expect(res.body.code).toBe(0);
    expect(
      res.body.data.items.map((i: { threadId: number }) => i.threadId),
    ).toEqual([tBob, tCarol]);
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.scannedThrough).toBe(3);
    expect(res.body.data.messageFeedEndId).toBe(3);
    // Each item carries its thread's newest body (no BigInt id leaks).
    const bob = res.body.data.items.find(
      (i: { threadId: number }) => i.threadId === tBob,
    );
    expect(bob.latestMessage).toMatchObject({
      seq: 3,
      content: JSON.stringify({ text: 'Bob-2' }),
    });
    expect(bob.latestMessage).not.toHaveProperty('id');
  });

  it('catch-up paginates and advances scannedThrough to the page boundary', async () => {
    // from absent (first boot), to = Carol's latest, take 2 → ASC oldest-first 2 of (−∞, carolLatest].
    const res = await getSummary({
      after: 0,
      through: 3,
      take: 2,
    });
    expect(
      res.body.data.items.map((i: { threadId: number }) => i.threadId),
    ).toEqual([tAlice, tBob]); // ids 3,6
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.scannedThrough).toBe(2);
  });

  it('advances the sender feed and preview for cross-device sync', async () => {
    const now = new Date();
    await database.db.transaction(async (tx) => {
      await tx.insert(message).values({
        threadId: tAlice,
        seq: 4,
        originSeq: 4,
        contentType: ContentType.PURE_TEXT,
        content: JSON.stringify({ text: 'self-only' }),
        creator: recipientId,
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .update(messageThread)
        .set({
          curSeq: 4,
          lastMessageSeq: 4,
          lastMessageAt: now,
          updatedAt: now,
        })
        .where(eq(messageThread.id, tAlice));
      await ClientMessageFeedWriter.publishMessage(tx, tAlice, 4);
    });

    const advanced = await getSummary({ after: 3, take: 50 });
    expect(advanced.body.data.items).toHaveLength(1);
    expect(advanced.body.data.items[0]).toMatchObject({
      threadId: tAlice,
      latestMessage: {
        seq: 4,
        content: JSON.stringify({ text: 'self-only' }),
        creator: recipientId,
      },
    });
    expect(advanced.body.data.messageFeedEndId).toBe(4);

    const replay = await getSummary({ after: 0, through: 4, take: 50 });
    const alice = replay.body.data.items.find(
      (item: { threadId: number }) => item.threadId === tAlice,
    );
    expect(alice.latestMessage.seq).toBe(4);
    expect(alice.latestMessage.content).toContain('self-only');
  });

  it('catch-up rejects a through cursor below after', async () => {
    const res = await getSummary({
      after: 3,
      through: 1,
      take: 50,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(BusinessCode.VALIDATION_FAILED);
  });

  it('catch-up returns recovery bounds when after is missing', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/thread-sync/catch-up')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE);
    expect(res.body.data).toEqual({ resumeAfter: 0, resumeBefore: 4 });
  });

  it('catch-up rejects an invalid page size instead of clamping it', async () => {
    const res = await getSummary({ after: 0, take: 201 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(BusinessCode.VALIDATION_FAILED);
  });

  // ── /notification-feed/query ─────────────────────────────────────────────────────────────────

  it('notification feed at the current end returns a clear descriptor', async () => {
    const res = await postMissed({ after: 3 });
    expect(res.body.data.notifications).toHaveLength(1);
    expect(res.body.data.notifications[0].kind).toBe('clear');
  });

  it('missed: returns one message-preview descriptor per conversation (en)', async () => {
    // since = Alice's seq 1 (the globally-oldest message) → everything after it: Alice 2,3 + Bob 1,2,3 +
    // Carol 1,2,3 = 8 messages across 3 senders → manyConv "Alice, Bob +1 sent you 8 messages".
    const res = await postMissed(
      { after: 0, threadHwms: { [tAlice]: 1 } },
      { 'Accept-Language': 'en' },
    );
    const descriptors = res.body.data.notifications;
    expect(
      descriptors.map((d: { data: { threadId: number } }) => d.data.threadId),
    ).toEqual([tCarol, tBob, tAlice]);
    const alice = descriptors.find(
      (d: { data: { threadId: number } }) => d.data.threadId === tAlice,
    );
    expect(alice).toMatchObject({
      kind: 'thread-message',
      title: 'Alice',
      body: 'Alice sent you 2 messages',
      count: 2,
      lang: 'en',
      previewMode: 'message',
      data: { threadId: tAlice, seq: 3 },
    });
    expect(alice.messages.map((m: { text: string }) => m.text)).toEqual([
      'Alice-1',
      'Alice-2',
    ]);
    expect(alice.icon).toBeNull();
  });

  it('missed: private mode contains no sender or message content', async () => {
    const res = await postMissed(
      { after: 0, threadHwms: { [tAlice]: 1 }, previewMode: 'private' },
      { 'Accept-Language': 'zh-CN,zh;q=0.9' },
    );
    expect(res.body.data.notifications).toHaveLength(3);
    for (const descriptor of res.body.data.notifications) {
      expect(descriptor).toMatchObject({
        title: 'SOMS',
        body: '你有新消息',
        lang: 'zh-CN',
        previewMode: 'private',
      });
      expect(descriptor).not.toHaveProperty('messages');
      expect(JSON.stringify(descriptor)).not.toMatch(/Alice-|Bob-|Carol-/);
    }
  });

  it('missed: a blocked sender is excluded from the aggregation', async () => {
    // Block Carol's peer → her 3 messages drop out: Alice 1,2 + Bob 0,1,2 = 5, 2 senders.
    await database.db
      .update(threadParticipant)
      .set({ blocked: true, updatedAt: new Date() })
      .where(
        and(
          eq(threadParticipant.userId, recipientId),
          eq(threadParticipant.threadId, tCarol),
        ),
      );
    const res = await postMissed(
      { after: 0, threadHwms: { [tAlice]: 1 } },
      { 'Accept-Language': 'en' },
    );
    expect(
      res.body.data.notifications.map(
        (d: { data: { threadId: number } }) => d.data.threadId,
      ),
    ).toEqual([tBob, tAlice]);
  });

  it('missed: a muted thread is excluded from the aggregation', async () => {
    // Mute Bob's thread → Bob's 3 messages drop out: Alice 1,2 + Carol 0,1,2 = 5, 2 senders.
    await database.db
      .update(threadParticipant)
      .set({ muted: true })
      .where(
        and(
          eq(threadParticipant.userId, recipientId),
          eq(threadParticipant.threadId, tBob),
        ),
      );
    const res = await postMissed(
      { after: 0, threadHwms: { [tAlice]: 1 } },
      { 'Accept-Language': 'en' },
    );
    expect(
      res.body.data.notifications.map(
        (d: { data: { threadId: number } }) => d.data.threadId,
      ),
    ).toEqual([tCarol, tAlice]);
  });

  it('notification feed at the current end returns no conversation descriptors', async () => {
    const res = await postMissed({ after: 3 });
    expect(res.body.data.notifications).toEqual([
      expect.objectContaining({ kind: 'clear' }),
    ]);
  });
});
