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
  message,
  clientMessageFeed,
  threadParticipant,
  threadAudience,
  user,
} from '../src/database/schema';
import { InviteService } from '../src/invite/invite.service';
import {
  registerAndLogin,
  openSse,
  waitForSseEvent,
} from './federation-test-helpers';
import {
  findP2PRelationship,
  seedFederatedPeerNamespace,
} from './seed';

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
    const invite = await request(baseUrl)
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ account: 'bob' })
      .expect((res) => {
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(0);
      });

    const accept = await request(baseUrl)
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ inviteId: invite.body.data.inviteId });
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

    // Relationship metadata may write system history, but no user-authored message exists yet.
    const [emptyCount] = await database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(message)
      .where(eq(message.threadId, threadId));
    expect(emptyCount.count).toBeGreaterThanOrEqual(0);

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
      //    the client pulls it). Assert the signal targets this thread.
      const delivered = (await waitForSseEvent(
        reader,
        (event, data) =>
          event === 'NEW_MESSAGE' &&
          typeof data === 'object' &&
          data !== null &&
          (data as { threadId?: number }).threadId === threadId,
      )) as { seq: number };
      expect(delivered).toBeDefined();

      // 5. The row is committed and the SSE cursor identifies that exact row. The number of preceding
      //    SYSTEM records is an implementation detail and must not be baked into this behavior test.
      const [storedMessage] = await database.db
        .select()
        .from(message)
        .where(
          and(
            eq(message.threadId, threadId),
            eq(message.content, JSON.stringify({ text: 'first!' })),
          ),
        )
        .limit(1);
      expect(storedMessage).toBeDefined();
      expect(JSON.parse(storedMessage.content)).toEqual({ text: 'first!' });
      expect(delivered.seq).toBe(storedMessage.seq);
      expect(Number(storedMessage.seq)).toBeGreaterThanOrEqual(0);
      expect(storedMessage.originSeq).toBeNull();
    } finally {
      await reader.cancel();
    }

    const deleteReader = await openSse(baseUrl, bob.token);
    try {
      await request(baseUrl)
        .post('/api/v1/user/delete-friend')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ account: 'bob' })
        .expect((res) => {
          expect(res.status).toBe(200);
          expect(res.body.code).toBe(0);
        });
      const boundaryWake = (await waitForSseEvent(
        deleteReader,
        (event, data) =>
          event === 'NEW_MESSAGE' &&
          typeof data === 'object' &&
          data !== null &&
          (data as { threadId?: number }).threadId === threadId,
      )) as { seq: number };
      const boundary = await database.db.query.message.findFirst({
        where: and(
          eq(message.threadId, threadId),
          eq(message.seq, boundaryWake.seq),
          eq(message.contentType, 'SYSTEM'),
        ),
      });
      expect(boundary).toMatchObject({
        creatorAccount: null,
        creatorDomain: null,
      });
      const participants = await database.db.query.threadParticipant.findMany({
        where: eq(threadParticipant.threadId, threadId),
      });
      expect(
        participants.map((participant) => participant.messageVisibleBeforeSeq),
      ).toEqual([boundaryWake.seq + 1, boundaryWake.seq + 1]);
      const projections = await database.db.query.clientMessageFeed.findMany({
        where: and(
          eq(clientMessageFeed.threadId, threadId),
          eq(clientMessageFeed.messageEndSeq, boundaryWake.seq),
        ),
      });
      expect(projections.map((projection) => projection.userId).sort()).toEqual(
        [alice.id, bob.id].sort(),
      );
    } finally {
      await deleteReader.cancel();
    }
    const revokedAudiences = await database.db
      .select({ id: threadAudience.id })
      .from(threadAudience)
      .where(eq(threadAudience.threadId, threadId));
    expect(revokedAudiences).toHaveLength(0);
  });

  it('creates one local-user audience and one peer-domain audience for a federated friendship', async () => {
    const appLike = { baseUrl, database: database.db };
    const alice = await registerAndLogin(appLike, 'alice', 'Alice');
    const namespaceId = await seedFederatedPeerNamespace(
      database.db,
      'peer.test',
    );
    const [foreignBob] = await database.db
      .insert(user)
      .values({
        account: 'bob',
        name: 'Bob',
        domain: 'peer.test',
        sourceDomain: 'peer.test',
        namespaceId,
        updatedAt: new Date(),
      })
      .returning({ id: user.id });

    const inviteService = app.get(InviteService);
    await database.db.transaction(async (tx) => {
      await inviteService.writeLocalFriendIntentInTx(
        tx,
        alice.id,
        foreignBob.id,
        true,
      );
      await inviteService.writeLocalFriendIntentInTx(
        tx,
        foreignBob.id,
        alice.id,
        true,
      );
    });
    const friendship = (
      await findP2PRelationship(database.db, alice.id, foreignBob.id)
    ).pair;
    expect(friendship?.threadId).not.toBeNull();
    const audiences = await database.db
      .select({
        targetDomain: threadAudience.targetDomain,
        localUserId: threadAudience.localUserId,
      })
      .from(threadAudience)
      .where(eq(threadAudience.threadId, friendship!.threadId!));

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

  it('immediately confirms crossed federated friend requests', async () => {
    const appLike = { baseUrl, database: database.db };
    const alice = await registerAndLogin(appLike, 'strict-alice', 'Alice');
    const namespaceId = await seedFederatedPeerNamespace(
      database.db,
      'strict-peer.test',
    );
    const [foreignBob] = await database.db
      .insert(user)
      .values({
        account: 'strict-bob',
        name: 'Bob',
        domain: 'strict-peer.test',
        sourceDomain: 'strict-peer.test',
        namespaceId,
        updatedAt: new Date(),
      })
      .returning({ id: user.id });
    const inviteService = app.get(InviteService);
    await database.db.transaction((tx) =>
      inviteService.writeLocalFriendIntentInTx(
        tx,
        alice.id,
        foreignBob.id,
        true,
      ),
    );
    await database.db.transaction((tx) =>
      inviteService.applyRemoteFriendIntentInTx(tx, {
        localUserId: alice.id,
        peerUserId: foreignBob.id,
        status: 'REQUESTED',
        note: 'crossed request',
        requestedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        origin: 'strict-peer.test',
      }),
    );

    const afterCrossedRequest = (
      await findP2PRelationship(database.db, alice.id, foreignBob.id)
    ).pair;
    expect(afterCrossedRequest?.active).toBe(true);
    expect(afterCrossedRequest?.threadId).not.toBeNull();

    await database.db.transaction((tx) =>
      inviteService.applyRemoteFriendIntentInTx(tx, {
        localUserId: alice.id,
        peerUserId: foreignBob.id,
        status: 'ACCEPTED',
        note: 'crossed request',
        requestedAt: new Date(),
        expiresAt: null,
        origin: 'strict-peer.test',
      }),
    );

    const afterConfirmation = (
      await findP2PRelationship(database.db, alice.id, foreignBob.id)
    ).pair;
    expect(afterConfirmation?.active).toBe(true);
    expect(afterConfirmation?.threadId).not.toBeNull();
  });
});
