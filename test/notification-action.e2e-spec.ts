import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';
import { ContentType } from '../src/prisma/generated/client.js';
import { seedUser, seedSession } from './seed';

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
  let prisma: PrismaService;
  let sessionToken: string;
  let recipientId: number;
  let threadId: number;
  let peerId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
    const recipient = await seedUser(app, 'recip', { name: 'Recip' });
    recipientId = recipient.id;
    sessionToken = await seedSession(app, recipientId, 'app');
    const peer = await prisma.user.create({
      data: { account: 'alice', hashPwd: 'x', name: 'Alice', isForeigner: false },
    });
    peerId = peer.id;
    const thread = await prisma.messageThread.create({
      data: { type: 'P2P', curSeq: 1, lastMessageSeq: 1, lastMessageAt: new Date() },
    });
    threadId = thread.id;
    await prisma.threadParticipant.createMany({
      data: [
        { userId: recipientId, threadId },
        { userId: peerId, threadId },
      ],
    });
    // seq 0 = the recipient's own outgoing message (the high-water mark before backgrounding); seq 1 =
    // Alice's reply that arrives while away. /notifications/missed is pulled with since = seq 0.
    await prisma.message.create({
      data: {
        threadId, seq: 0, originSeq: 0, contentType: ContentType.PURE_TEXT,
        content: 'yo', creator: recipientId, createdAt: new Date(Date.now() - 1000),
      },
    });
    await prisma.message.create({
      data: {
        threadId, seq: 1, originSeq: 1, contentType: ContentType.PURE_TEXT,
        content: 'hi', creator: peerId, createdAt: new Date(),
      },
    });
  });

  function auth() {
    return { Authorization: `Bearer ${sessionToken}` };
  }

  it('the descriptor carries a single dismiss action + no routing data (the tap is pure frontend)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/notifications/missed')
      .set(auth())
      .send({ since: { threadId, seq: 0 } });
    const d = res.body.data.notifications[0];
    expect(d.kind).toBe('thread-message');
    expect(d.title).toBe('Alice');
    expect(d.body).toBe('Alice sent you a message');
    expect(d.messages).toEqual([
      expect.objectContaining({ seq: 1, senderId: peerId, senderName: 'Alice', text: 'hi' }),
    ]);
    // The button is still authored by the server (each client renders it), but the tap is PURE frontend:
    // the client advances its away-HWM to this cursor + closes the shade — it never POSTs, never touches the
    // read watermark. `data` is the new HWM target (the global newest covered message = Alice's seq 1).
    expect(d.actions).toEqual([{ id: 'dismiss', title: 'Dismiss' }]);
    expect(d.data).toEqual({ threadId, seq: 1 });
  });

  it('reply creates a PURE_TEXT message from the recipient, fanned out like a normal send', async () => {
    const act = await request(app.getHttpServer())
      .post('/api/v1/notifications/action')
      .set(auth())
      .send({ tag: 'soms-msg', actionId: 'reply', threadId, replyText: '  thanks  ' });
    expect(act.body.code).toBe(0);

    // A new message row exists: seq 2, creator = recipient, content trimmed. (seq 0 = the recipient's HWM
    // baseline, seq 1 = Alice's reply, seq 2 = this inline reply.)
    const msgs = await prisma.message.findMany({
      where: { threadId }, orderBy: { seq: 'asc' },
    });
    expect(msgs.map((m) => m.seq)).toEqual([0, 1, 2]);
    const reply = msgs.find((m) => m.seq === 2)!;
    expect(reply.creator).toBe(recipientId);
    expect(reply.contentType).toBe(ContentType.PURE_TEXT);
    expect(reply.content).toBe('thanks'); // trimmed
    // The thread's lastMessageSeq advanced (the send pipeline allocated seq 2).
    const thread = await prisma.messageThread.findUnique({ where: { id: threadId } });
    expect(thread?.lastMessageSeq).toBe(2);
  });

  it('reply is refused for a thread the caller is not a member of (no message created)', async () => {
    // A thread the recipient is NOT in.
    const other = await prisma.user.create({
      data: { account: 'bob', hashPwd: 'x', name: 'Bob', isForeigner: false },
    });
    const otherThread = await prisma.messageThread.create({
      data: { type: 'P2P', curSeq: 0, lastMessageSeq: null },
    });
    await prisma.threadParticipant.createMany({
      data: [{ userId: other.id, threadId: otherThread.id }, { userId: peerId, threadId: otherThread.id }],
    });

    const act = await request(app.getHttpServer())
      .post('/api/v1/notifications/action')
      .set(auth())
      .send({ tag: 'soms-msg', actionId: 'reply', threadId: otherThread.id, replyText: 'intrude' });
    expect(act.body.code).toBe(0); // best-effort — 200, but no message created
    const created = await prisma.message.findMany({ where: { threadId: otherThread.id } });
    expect(created).toEqual([]);
  });
});
