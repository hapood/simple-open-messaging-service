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
import { ClientThreadContentHeadWriter } from '../src/message/client-message-feed.service.js';
import { seedAcceptedRelationship, seedUser, seedSession } from './seed';

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
        createdAt: new Date(base + index),
        updatedAt: now,
      })),
    );
    await database.db.transaction((tx) =>
      ClientThreadContentHeadWriter.publishMessage(tx, thread.id, 3),
    );
    return thread.id;
  }

  function getState(params: Record<string, string | number>) {
    return request(app.getHttpServer())
      .get('/api/v1/user/state-feed')
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

  // ── /user/state-feed ───────────────────────────────────────────────────────────────────────

  it('publishes paired message/tombstone heads and preview identities in the sole state feed', async () => {
    const res = await getState({ after: 0, take: 200, mode: 'full' });
    expect(res.body.code).toBe(0);
    const heads = res.body.data.items.filter(
      (item: { eventType: string }) => item.eventType === 'THREAD_CONTENT_HEAD',
    );
    expect(
      heads.map((item: { body: { threadId: number } }) => item.body.threadId),
    ).toEqual(expect.arrayContaining([tAlice, tBob, tCarol]));
    expect(
      heads.find(
        (item: { body: { threadId: number } }) => item.body.threadId === tBob,
      )?.body,
    ).toMatchObject({
      threadId: tBob,
      messageEndSeq: 3,
      tombstoneEndSeq: 0,
      preview: { seq: 3, text: 'Bob-2' },
    });
  });

  it('compacts a newer message into the same content head with a new state-feed coordinate', async () => {
    const before = await getState({ after: 0, take: 200, mode: 'full' });
    const previous = before.body.data.items.find(
      (item: { eventType: string; body: { threadId: number } }) =>
        item.eventType === 'THREAD_CONTENT_HEAD' &&
        item.body.threadId === tAlice,
    );
    const now = new Date();
    await database.db.transaction(async (tx) => {
      await tx.insert(message).values({
        threadId: tAlice,
        seq: 4,
        originSeq: 4,
        contentType: ContentType.PURE_TEXT,
        content: JSON.stringify({ text: 'self-only' }),
        creatorAccount: 'recip',
        creatorDomain: 'local',
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
      await ClientThreadContentHeadWriter.publishMessage(tx, tAlice, 4);
    });

    const advanced = await getState({
      after: previous.feedId,
      take: 200,
      mode: 'delta',
    });
    const alice = advanced.body.data.items.find(
      (item: { eventType: string; body: { threadId: number } }) =>
        item.eventType === 'THREAD_CONTENT_HEAD' &&
        item.body.threadId === tAlice,
    );
    expect(alice.feedId).toBeGreaterThan(previous.feedId);
    expect(alice.body).toMatchObject({
      threadId: tAlice,
      messageEndSeq: 4,
      tombstoneEndSeq: 0,
      preview: { seq: 4, text: 'self-only' },
    });

    const withdrawn = await request(app.getHttpServer())
      .post('/api/v1/withdraw-message')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ threadId: tAlice, seq: 4 });
    expect(withdrawn.body.code).toBe(0);
    const afterWithdraw = await getState({
      after: 0,
      take: 200,
      mode: 'full',
    });
    const withdrawnHead = afterWithdraw.body.data.items.find(
      (item: { eventType: string; body: { threadId: number } }) =>
        item.eventType === 'THREAD_CONTENT_HEAD' &&
        item.body.threadId === tAlice,
    );
    expect(withdrawnHead.body).toMatchObject({
      threadId: tAlice,
      messageEndSeq: 5,
      tombstoneEndSeq: 1,
      preview: { seq: 4, text: '', senderId: null },
    });

    const filteredTombstones = await request(app.getHttpServer())
      .post('/api/v1/deleted-messages/query')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({
        threadId: tAlice,
        after: 0,
        through: 1,
        take: 100,
        maxMessageSeq: 3,
      });
    expect(filteredTombstones.body.data).toEqual({
      tombstones: [],
      scannedThrough: 1,
      hasMore: false,
    });
  });

  // ── /notification-feed/query ─────────────────────────────────────────────────────────────────

  it('notification feed at the current end returns a clear descriptor', async () => {
    const state = await getState({ after: 0, take: 200, mode: 'full' });
    const res = await postMissed({ after: state.body.data.stateFeedEndId });
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
    const participant = await database.db.query.threadParticipant.findFirst({
      where: and(
        eq(threadParticipant.accountId, recipientId),
        eq(threadParticipant.threadId, tCarol),
      ),
      columns: { id: true },
    });
    if (!participant)
      throw new Error('recipient thread participant is missing');
    await database.db
      .update(threadParticipant)
      .set({ blocked: true, updatedAt: new Date() })
      .where(eq(threadParticipant.id, participant.id));
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
    const participant = await database.db.query.threadParticipant.findFirst({
      where: and(
        eq(threadParticipant.accountId, recipientId),
        eq(threadParticipant.threadId, tBob),
      ),
      columns: { id: true },
    });
    if (!participant)
      throw new Error('recipient thread participant is missing');
    await database.db
      .update(threadParticipant)
      .set({ muted: true })
      .where(eq(threadParticipant.id, participant.id));
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
    const state = await getState({ after: 0, take: 200, mode: 'full' });
    const res = await postMissed({ after: state.body.data.stateFeedEndId });
    expect(res.body.data.notifications).toEqual([
      expect.objectContaining({ kind: 'clear' }),
    ]);
  });
});
