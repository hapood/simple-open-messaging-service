import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { asc, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/database/database.service';
import { message, messageThread, user } from '../src/database/schema';
import { ContentType } from '../src/database/enums.js';
import { ClientThreadContentHeadWriter } from '../src/message/client-message-feed.service.js';
import { seedAcceptedRelationship, seedUser, seedSession } from './seed';

/**
 * /notifications/action e2e — the descriptor button round-trip. Seeds a P2P thread with an unread message,
 * pulls the descriptor (asserts it carries a single `dismiss` action with NO routing data), then exercises
 * `reply`:
 *  - reply → a new PURE_TEXT Message row lands (creator = the replying user, content = replyText),
 *            fanned out like a normal send.
 * (`dismiss` is a pure frontend shade-close — never POSTed — so it has no backend case here.)
 */
describe('notifications/action (descriptor button round-trip)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let sessionToken: string;
  let recipientId: number;
  let threadId: number;
  let peerId: number;

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
    const now = new Date();
    const [peer] = await database.db
      .insert(user)
      .values({
        account: 'alice',
        hashPwd: 'x',
        name: 'Alice',
        updatedAt: now,
      })
      .returning({ id: user.id });
    peerId = peer.id;
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'P2P',
        curSeq: 2,
        lastMessageSeq: 2,
        lastMessageAt: now,
        updatedAt: now,
      })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await seedAcceptedRelationship(database.db, recipientId, peerId, threadId);
    // seq 1 = the recipient's own outgoing message (the high-water mark before backgrounding); seq 2 =
    // Alice's reply that arrives while away and advances the recipient's message feed.
    await database.db.insert(message).values([
      {
        threadId,
        seq: 1,
        originSeq: 1,
        contentType: ContentType.PURE_TEXT,
        content: JSON.stringify({ text: 'yo' }),
        creatorAccount: 'recip',
        creatorDomain: 'local',
        createdAt: new Date(Date.now() - 1000),
        updatedAt: now,
      },
      {
        threadId,
        seq: 2,
        originSeq: 2,
        contentType: ContentType.PURE_TEXT,
        content: JSON.stringify({ text: 'hi' }),
        creatorAccount: 'alice',
        creatorDomain: 'local',
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await database.db.transaction((tx) =>
      ClientThreadContentHeadWriter.publishMessage(tx, threadId, 2),
    );
  });

  function auth() {
    return { Authorization: `Bearer ${sessionToken}` };
  }

  it('the descriptor carries a single dismiss action + no routing data (the tap is pure frontend)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/notification-feed/query')
      .set(auth())
      .send({ after: 0, threadHwms: { [threadId]: 1 } });
    const d = res.body.data.notifications[0];
    expect(d.kind).toBe('thread-message');
    expect(d.title).toBe('Alice');
    expect(d.body).toBe('Alice sent you a message');
    expect(d.messages).toEqual([
      expect.objectContaining({
        seq: 2,
        sender: { account: 'alice', domain: 'local' },
        senderName: 'Alice',
        text: 'hi',
      }),
    ]);
    // The button is still authored by the server (each client renders it), but the tap is PURE frontend:
    // the client advances its away-HWM to this cursor + closes the shade — it never POSTs, never touches the
    // read watermark. `data` is the new HWM target (the global newest covered message = Alice's seq 2).
    expect(d.actions).toEqual([{ id: 'dismiss', title: 'Dismiss' }]);
    expect(d.data).toEqual({ threadId, seq: 2 });
  });

  it('reply creates a PURE_TEXT message from the recipient, fanned out like a normal send', async () => {
    const act = await request(app.getHttpServer())
      .post('/api/v1/notifications/action')
      .set(auth())
      .send({
        tag: 'soms-msg',
        actionId: 'reply',
        threadId,
        replyText: '  thanks  ',
      });
    expect(act.body.code).toBe(0);

    // A new message row exists: seq 3, creator = recipient, content trimmed. (seq 1 = the recipient's HWM
    // baseline, seq 2 = Alice's reply, seq 3 = this inline reply.)
    const msgs = await database.db
      .select()
      .from(message)
      .where(eq(message.threadId, threadId))
      .orderBy(asc(message.seq));
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3]);
    const reply = msgs.find((m) => m.seq === 3)!;
    expect(reply.creatorAccount).toBe('recip');
    expect(reply.creatorDomain).toBe('local');
    expect(reply.contentType).toBe(ContentType.PURE_TEXT);
    expect(JSON.parse(reply.content)).toEqual({ text: 'thanks' }); // trimmed
    // The thread's lastMessageSeq advanced (the send pipeline allocated seq 3).
    const [thread] = await database.db
      .select()
      .from(messageThread)
      .where(eq(messageThread.id, threadId))
      .limit(1);
    expect(thread?.lastMessageSeq).toBe(3);
  });

  it('reply is refused for a thread the caller is not a member of (no message created)', async () => {
    // A thread the recipient is NOT in.
    const now = new Date();
    const [other] = await database.db
      .insert(user)
      .values({
        account: 'bob',
        hashPwd: 'x',
        name: 'Bob',
        updatedAt: now,
      })
      .returning({ id: user.id });
    const [otherThread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', curSeq: 0, lastMessageSeq: null, updatedAt: now })
      .returning({ id: messageThread.id });
    await seedAcceptedRelationship(
      database.db,
      other.id,
      peerId,
      otherThread.id,
    );

    const act = await request(app.getHttpServer())
      .post('/api/v1/notifications/action')
      .set(auth())
      .send({
        tag: 'soms-msg',
        actionId: 'reply',
        threadId: otherThread.id,
        replyText: 'intrude',
      });
    expect(act.body.code).toBe(0); // best-effort — 200, but no message created
    const created = await database.db
      .select()
      .from(message)
      .where(eq(message.threadId, otherThread.id));
    expect(created).toEqual([]);
  });
});
