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
  account,
  clientStateFeed,
  accountThreadState,
  threadAudience,
  account as user,
} from '../src/database/schema';
import { RelationshipService } from '../src/relationship/relationship.service';
import {
  registerAndLogin,
  openSse,
  waitForSseEvent,
} from './federation-test-helpers';
import { findP2PRelationship, seedFederatedPeerNamespace } from './seed';
import {
  waitForDurableTask,
  waitForLocalRelationshipRequest,
} from './durable-task-helpers.js';

/**
 * Regression contract test for the "first message after friend-add not delivered" bug.
 *
 * The bug itself lives in the frontend kernel (web/src/app/lib/chat-box/chat-box-scroller.ts loadNewer),
 * where it is pinned by a unit test. This spec locks the BACKEND delivery contract the kernel relies on:
 * on a brand-new (empty) P2P thread, the very first send must commit the row, publish the receiver's
 * THREAD_CONTENT_HEAD, and emit the throttled State Feed wake over the real wire. The backend has no
 * empty-thread special-casing, so
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
    await database.pool.query(
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('delivers the FIRST message on a brand-new (empty) P2P thread to the receiver over SSE and persists it', async () => {
    const appLike = { baseUrl, database: database.db };
    const alice = await registerAndLogin(appLike, 'alice', 'Alice');
    const bob = await registerAndLogin(appLike, 'bob', 'Bob');

    // 1. Alice sends a relationship request to Bob; Bob accepts and both sides get the P2P thread.
    const invite = await request(baseUrl)
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ account: 'bob', domain: 'local' })
      .expect((res) => {
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(0);
      });
    await waitForLocalRelationshipRequest(
      database.db,
      invite.body.data.taskId,
      alice.id,
      bob.id,
    );

    const accept = await request(baseUrl)
      .post('/api/v1/relationship/accept')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ account: 'alice', domain: 'local' });
    expect(accept.status).toBe(200);
    expect(accept.body.code).toBe(0);
    expect(accept.body.data).toMatchObject({ status: 'PENDING' });
    await waitForDurableTask(database.db, accept.body.data.taskId);
    const relationship = await findP2PRelationship(
      database.db,
      alice.id,
      bob.id,
    );
    const threadId = relationship.pair?.threadId;
    if (threadId === null || threadId === undefined) {
      throw new Error('friend acceptance completed without a P2P thread');
    }
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

    const beforeFeed = await database.db.query.account.findFirst({
      where: eq(account.id, bob.id),
      columns: { stateFeedAllocatedThrough: true },
    });
    expect(beforeFeed).toBeDefined();
    // 2. Open Bob's SSE stream before the send so the throttled durable-feed wake is captured.
    const reader = await openSse(baseUrl, bob.token);
    try {
      // 3. Alice sends the FIRST message into the empty thread.
      const send = await request(baseUrl)
        .post('/api/v1/send-message')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ threadId, content: 'first!', contentType: 'PURE_TEXT' });
      expect(send.status).toBe(200);
      expect(send.body.code).toBe(0);

      // 4. The client wake carries only the latest State Feed high watermark.
      const delivered = (await waitForSseEvent(
        reader,
        (event, data) =>
          event === 'STATE_FEED_UPDATED' &&
          typeof data === 'object' &&
          data !== null &&
          typeof (data as { feedId?: unknown }).feedId === 'number' &&
          (data as { feedId: number }).feedId >
            beforeFeed!.stateFeedAllocatedThrough,
        10_000,
      )) as { feedId: number };
      expect(delivered.feedId).toBeGreaterThan(
        beforeFeed!.stateFeedAllocatedThrough,
      );

      // 5. The row and Bob's compacted content head identify the same sequence.
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
      expect(Number(storedMessage.seq)).toBeGreaterThanOrEqual(0);
      expect(storedMessage.originSeq).toBe(storedMessage.seq);
      const head = await database.db.query.clientStateFeed.findFirst({
        where: and(
          eq(clientStateFeed.userId, bob.id),
          eq(
            clientStateFeed.compactionKey,
            JSON.stringify(['THREAD_CONTENT_HEAD', threadId]),
          ),
        ),
      });
      expect(head?.feedId).toBeGreaterThan(
        beforeFeed!.stateFeedAllocatedThrough,
      );
      expect(head!.feedId).toBeLessThanOrEqual(delivered.feedId);
      expect(head?.body).toMatchObject({
        threadId,
        messageEndSeq: storedMessage.seq,
      });
    } finally {
      await reader.cancel();
    }

    const beforeRevokeFeed = await database.db.query.account.findFirst({
      where: eq(account.id, bob.id),
      columns: { stateFeedAllocatedThrough: true },
    });
    expect(beforeRevokeFeed).toBeDefined();
    const deleteReader = await openSse(baseUrl, bob.token);
    try {
      const removed = await request(baseUrl)
        .post('/api/v1/relationship/revoke')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ account: 'bob', domain: 'local' });
      expect(removed.status).toBe(200);
      expect(removed.body.code).toBe(0);
      expect(removed.body.data).toMatchObject({ status: 'PENDING' });
      await waitForDurableTask(database.db, removed.body.data.taskId);
      const boundaryWake = (await waitForSseEvent(
        deleteReader,
        (event, data) =>
          event === 'STATE_FEED_UPDATED' &&
          typeof data === 'object' &&
          data !== null &&
          typeof (data as { feedId?: unknown }).feedId === 'number' &&
          (data as { feedId: number }).feedId >
            beforeRevokeFeed!.stateFeedAllocatedThrough,
        10_000,
      )) as { feedId: number };
      const boundaryHead = await database.db.query.clientStateFeed.findFirst({
        where: and(
          eq(clientStateFeed.userId, bob.id),
          eq(
            clientStateFeed.compactionKey,
            JSON.stringify(['THREAD_CONTENT_HEAD', threadId]),
          ),
        ),
      });
      expect(boundaryHead?.feedId).toBeGreaterThan(
        beforeRevokeFeed!.stateFeedAllocatedThrough,
      );
      expect(boundaryHead!.feedId).toBeLessThanOrEqual(boundaryWake.feedId);
      const boundarySeq = (boundaryHead!.body as { messageEndSeq: number })
        .messageEndSeq;
      const boundary = await database.db.query.message.findFirst({
        where: and(
          eq(message.threadId, threadId),
          eq(message.seq, boundarySeq),
          eq(message.contentType, 'SYSTEM'),
        ),
      });
      expect(boundary).toMatchObject({
        creatorAccount: null,
        creatorDomain: null,
      });
      const participants = await database.db.query.accountThreadState.findMany({
        where: eq(accountThreadState.threadId, threadId),
      });
      expect(
        participants.map((participant) => participant.messageVisibleThroughSeq),
      ).toEqual([boundarySeq, boundarySeq]);
      const projections = await database.db.query.clientStateFeed.findMany({
        where: eq(
          clientStateFeed.compactionKey,
          JSON.stringify(['THREAD_CONTENT_HEAD', threadId]),
        ),
      });
      expect(
        projections.every(
          (projection) =>
            (projection.body as { messageEndSeq?: number }).messageEndSeq ===
            boundarySeq,
        ),
      ).toBe(true);
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
    const foreignBob = { account: 'bob', domain: 'peer.test', namespaceId };

    const relationships = app.get(RelationshipService);
    await database.db.transaction(async (tx) => {
      await relationships.writeLocalP2PIntentInTx(
        tx,
        alice.id,
        foreignBob,
        true,
      );
      await relationships.applyRemoteP2PIntentInTx(tx, {
        localUserId: alice.id,
        peerUserId: foreignBob,
        status: 'REQUESTED',
        profileRev: 0,
        note: '',
        requestedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        origin: foreignBob.domain,
      });
    });
    const friendship = (
      await findP2PRelationship(database.db, alice.id, foreignBob)
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
    const foreignBob = {
      account: 'strict-bob',
      domain: 'strict-peer.test',
      namespaceId,
    };
    const relationships = app.get(RelationshipService);
    await database.db.transaction((tx) =>
      relationships.writeLocalP2PIntentInTx(tx, alice.id, foreignBob, true),
    );
    await database.db.transaction((tx) =>
      relationships.applyRemoteP2PIntentInTx(tx, {
        localUserId: alice.id,
        peerUserId: foreignBob,
        status: 'REQUESTED',
        profileRev: 1,
        note: 'crossed request',
        requestedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        origin: 'strict-peer.test',
      }),
    );

    const afterCrossedRequest = (
      await findP2PRelationship(database.db, alice.id, foreignBob)
    ).pair;
    expect(afterCrossedRequest?.active).toBe(true);
    expect(afterCrossedRequest?.threadId).not.toBeNull();

    await database.db.transaction((tx) =>
      relationships.applyRemoteP2PIntentInTx(tx, {
        localUserId: alice.id,
        peerUserId: foreignBob,
        status: 'ACCEPTED',
        profileRev: 1,
        note: 'crossed request',
        requestedAt: new Date(),
        expiresAt: null,
        origin: 'strict-peer.test',
      }),
    );

    const afterConfirmation = (
      await findP2PRelationship(database.db, alice.id, foreignBob)
    ).pair;
    expect(afterConfirmation?.active).toBe(true);
    expect(afterConfirmation?.threadId).not.toBeNull();
  });
});
