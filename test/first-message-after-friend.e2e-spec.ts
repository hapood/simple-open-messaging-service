import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service';
import {
  invite,
  message,
  threadAudience,
  user,
} from '../src/database/schema';
import { InviteService } from '../src/invite/invite.service';
import {
  registerAndLogin,
  openSse,
  waitForSseEvent,
} from './federation-test-helpers';

/**
 * Regression contract test for the "first message after friend-add not delivered" bug.
 *
 * The bug itself lives in the frontend kernel (web/src/app/lib/chat-box/chat-box-scroller.ts loadNewer),
 * where it is pinned by a unit test. This spec locks the BACKEND delivery contract the kernel relies on:
 * on a brand-new (empty) P2P thread, the very first send must (a) commit the row, and (b) fan a NEW_MESSAGE
 * SSE frame to the other participant over the real wire. The backend has no empty-thread special-casing, so
 * this also guards against any future regression in the fan-out path (participant lookup, fire-and-forget
 * dispatch, SSE registry) that would break first-message delivery.
 *
 * Single-instance (both users local), bootstrapped in-process like test/auth.e2e-spec.ts. Reuses the
 * federation-test-helpers HTTP/SSE helpers by wrapping the app with its base URL and database handle.
 */
describe('First message after friend-add is delivered (single instance)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
    // Resolve the OS-assigned port so the helpers can reach the app over real HTTP/SSE (mirrors the
    // federation subprocess harness, which reaches apps at http://127.0.0.1:<port>).
    const address = (
      app.getHttpServer() as { address: () => { port: number } | string | null }
    ).address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  beforeEach(async () => {
    // Truncating User CASCADE-clears threads, messages, invites, etc. — a fresh graph per test.
    await database.pool.query('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await app.close();
  });

  it('delivers the FIRST message on a brand-new (empty) P2P thread to the receiver over SSE and persists it', async () => {
    const appLike = { baseUrl, database: database.db };
    const alice = await registerAndLogin(appLike, 'alice', 'Alice');
    const bob = await registerAndLogin(appLike, 'bob', 'Bob');

    // 1. Alice sends the friend invite to Bob; Bob accepts → both sides get the new P2P thread.
    await request(baseUrl)
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ toUserId: bob.id })
      .expect((res) => {
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(0);
      });

    const [pendingInvite] = await database.db
      .select()
      .from(invite)
      .where(
        and(
          eq(invite.kind, 'FRIEND'),
          eq(invite.status, 'PENDING'),
          eq(invite.fromUserId, alice.id),
          eq(invite.toUserId, bob.id),
        ),
      )
      .limit(1);
    expect(pendingInvite).toBeDefined();

    const accept = await request(baseUrl)
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ inviteId: pendingInvite.id.toString() });
    expect(accept.status).toBe(200);
    expect(accept.body.code).toBe(0);
    const threadId: number = accept.body.data.threadId;
    expect(threadId).toBeGreaterThan(0);

    const audiences = await database.db
      .select({
        targetDomain: threadAudience.targetDomain,
        localUserId: threadAudience.localUserId,
      })
      .from(threadAudience)
      .where(eq(threadAudience.threadId, threadId));
    expect(audiences).toEqual(
      expect.arrayContaining([
        {
          targetDomain: 'local',
          localUserId: alice.id,
        },
        {
          targetDomain: 'local',
          localUserId: bob.id,
        },
      ]),
    );
    expect(audiences).toHaveLength(2);

    // Sanity: the thread truly has NO messages yet (this is the "empty chatbox" precondition).
    const [emptyCount] = await database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(message)
      .where(eq(message.threadId, threadId));
    expect(emptyCount.count).toBe(0);

    // 2. Open Bob's SSE stream BEFORE the send so the NEW_MESSAGE frame is captured on the real wire.
    const reader = await openSse(baseUrl, bob.token);
    try {
      // 3. Alice sends the FIRST message into the empty thread.
      const send = await request(baseUrl)
        .post('/api/v1/send-message')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ threadId, content: 'first!', contentType: 'PURE_TEXT' });
      expect(send.status).toBe(200);
      expect(send.body.code).toBe(0);

      // 4. The fan-out wrote a NEW_MESSAGE signal to Bob's stream. The frame is identity-only
      //    { threadId, seq, ts } — the rendered body is never carried on the wire (single data source:
      //    the client pulls it). Assert the signal targets this thread at seq 0 (the first message).
      const delivered = await waitForSseEvent(
        reader,
        (event, data) =>
          event === 'NEW_MESSAGE' &&
          typeof data === 'object' &&
          data !== null &&
          (data as { threadId?: number }).threadId === threadId &&
          (data as { seq?: number }).seq === 0,
      );
      expect(delivered).toBeDefined();

      // 5. The row is committed and it is genuinely the first message (seq/originSeq 0 — curSeq starts at -1).
      const [storedMessage] = await database.db
        .select()
        .from(message)
        .where(eq(message.threadId, threadId))
        .limit(1);
      expect(storedMessage).toBeDefined();
      expect(JSON.parse(storedMessage.content)).toEqual({ text: 'first!' });
      expect(Number(storedMessage.seq)).toBe(0);
      expect(Number(storedMessage.originSeq)).toBe(0);
    } finally {
      await reader.cancel();
    }

    await request(baseUrl)
      .post('/api/v1/user/delete-friend')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ userId: bob.id })
      .expect((res) => {
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(0);
      });
    const revokedAudiences = await database.db
      .select({ id: threadAudience.id })
      .from(threadAudience)
      .where(eq(threadAudience.threadId, threadId));
    expect(revokedAudiences).toEqual([]);
  });

  it('creates one local-user audience and one peer-domain audience for a federated friendship', async () => {
    const appLike = { baseUrl, database: database.db };
    const alice = await registerAndLogin(appLike, 'alice', 'Alice');
    const [foreignBob] = await database.db
      .insert(user)
      .values({
        account: 'bob',
        name: 'Bob',
        isForeigner: true,
        domain: 'peer.test',
        updatedAt: new Date(),
      })
      .returning({ id: user.id });

    const friendship = await app
      .get(InviteService)
      .applyInboundFriendApprove(alice.id, foreignBob.id);
    const audiences = await database.db
      .select({
        targetDomain: threadAudience.targetDomain,
        localUserId: threadAudience.localUserId,
      })
      .from(threadAudience)
      .where(eq(threadAudience.threadId, friendship.threadId));

    expect(audiences).toEqual(
      expect.arrayContaining([
        {
          targetDomain: 'local',
          localUserId: alice.id,
        },
        {
          targetDomain: 'peer.test',
          localUserId: null,
        },
      ]),
    );
    expect(audiences).toHaveLength(2);
  });
});
