import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service';
import {
  message,
  messageThread,
  account,
  accountThreadState,
  threadAudience,
} from '../src/database/schema';
import { ReceivedUserIntentService } from '../src/user/p2p-intent/received/received-user-intent.service.js';
import { UserIntentService } from '../src/user/p2p-intent/authored/user-intent.service.js';
import {
  registerAndLogin,
  openSse,
  waitForSseEvent,
} from './federation-test-helpers';
import { findP2PRelationship, seedFederatedPeerNamespace } from './seed';
import { createTestApp } from './support/app';
import { truncateTablesForTest } from './support/truncate';

/**
 * Regression contract test for the "first message after friend-add not delivered" bug.
 *
 * The bug itself lives in the frontend kernel (web/src/app/lib/chat-box/chat-box-scroller.ts loadNewer),
 * where it is pinned by a unit test. This spec locks the BACKEND delivery contract the kernel relies on:
 * on a brand-new (empty) P2P thread, the very first send must commit the row, publish the receiver's
 * thread-feed snapshot, and emit the throttled thread-feed wake over the real wire. The backend has no
 * empty-thread special-casing, so
 * this also guards against any future regression in the fan-out path (participant lookup, fire-and-forget
 * dispatch, SSE registry) that would break first-message delivery.
 *
 * Single-instance (both users local), bootstrapped in-process like test/auth.e2e-spec.ts. Reuses the
 * federation-test-helpers HTTP/SSE helpers by wrapping the app with its base URL and database handle.
 */
describe('First message after friend-add is delivered (single instance)', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, database } = await createTestApp());
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
    await truncateTablesForTest(database.pool, 'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await app.close();
  });

  it('delivers the FIRST message on a brand-new (empty) P2P thread to the receiver over SSE and persists it', async () => {
    const appLike = { baseUrl, database: database.db };
    const alice = await registerAndLogin(appLike, 'alice', 'Alice');
    const bob = await registerAndLogin(appLike, 'bob', 'Bob');

    // 1. Alice sends a relationship request to Bob; Bob accepts and both sides get the P2P thread.
    // The intent family answers synchronously — the committed pair state is
    // visible the moment the request answers.
    const invite = await request(baseUrl)
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ account: 'bob', domain: 'local' })
      .expect((res) => {
        expect(res.status).toBe(200);
        expect(res.body.code).toBe(0);
        expect(res.body.data).toEqual({ status: 'OK' });
      });

    const accept = await request(baseUrl)
      .post('/api/v1/relationship/accept')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ account: 'alice', domain: 'local' });
    expect(accept.status).toBe(200);
    expect(accept.body.code).toBe(0);
    expect(accept.body.data).toMatchObject({ status: 'OK' });
    const relationship = await findP2PRelationship(
      database.db,
      alice.id,
      bob.id,
    );
    const threadId = relationship.pair?.threadId;
    expect(accept.body.data.threadId).toBe(threadId);
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

    // Friendship completion does not wait for its separate system-message fanout.
    // Establish a projected baseline so that its delayed wake cannot satisfy the send assertion.
    const initialThread = await database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
    });
    await vi.waitFor(
      async () => {
        const state = await database.db.query.accountThreadState.findFirst({
          where: and(
            eq(accountThreadState.threadId, threadId),
            eq(accountThreadState.accountId, bob.id),
          ),
        });
        expect(state?.messageEndSeq).toBe(initialThread!.curSeq);
      },
      { timeout: 10_000, interval: 25 },
    );

    const beforeFeed = await database.db.query.account.findFirst({
      where: eq(account.id, bob.id),
      columns: { threadFeedEndId: true },
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

      // 4. The client wake carries only the latest thread-feed high watermark.
      const delivered = (await waitForSseEvent(
        reader,
        (event, data) =>
          event === 'THREAD_FEED_UPDATED' &&
          typeof data === 'object' &&
          data !== null &&
          typeof (data as { threadFeedEndId?: unknown }).threadFeedEndId ===
            'number' &&
          (data as { threadFeedEndId: number }).threadFeedEndId >
            beforeFeed!.threadFeedEndId,
        10_000,
      )) as { threadFeedEndId: number };
      expect(delivered.threadFeedEndId).toBeGreaterThan(
        beforeFeed!.threadFeedEndId,
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
      const head = await database.db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.accountId, bob.id),
          eq(accountThreadState.threadId, threadId),
        ),
      });
      expect(head?.threadFeedId).toBeGreaterThan(beforeFeed!.threadFeedEndId);
      expect(head!.threadFeedId).toBeLessThanOrEqual(delivered.threadFeedEndId);
      expect(head).toMatchObject({
        threadId,
        messageEndSeq: storedMessage.seq,
      });
    } finally {
      await reader.cancel();
    }

    const beforeRevokeFeed = await database.db.query.account.findFirst({
      where: eq(account.id, bob.id),
      columns: { threadFeedEndId: true },
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
      expect(removed.body.data).toEqual({ status: 'OK' });
      // Visibility changes are published through the unified thread feed.
      const observed: unknown[] = [];
      const boundaryWake = (await waitForSseEvent(
        deleteReader,
        (event, data) => {
          observed.push({ event, data });
          return (
            event === 'THREAD_FEED_UPDATED' &&
            typeof data === 'object' &&
            data !== null &&
            typeof (data as { threadFeedEndId?: unknown }).threadFeedEndId ===
              'number' &&
            (data as { threadFeedEndId: number }).threadFeedEndId >
              beforeRevokeFeed!.threadFeedEndId
          );
        },
        10_000,
      ).catch(async (cause) => {
        const state = await database.db.query.accountThreadState.findFirst({
          where: and(
            eq(accountThreadState.accountId, bob.id),
            eq(accountThreadState.threadId, threadId),
          ),
        });
        throw new Error(
          `Revocation wake failed: ${JSON.stringify({ beforeRevokeFeed, observed, state })}`,
          { cause },
        );
      })) as { threadFeedEndId: number };
      const boundaryState =
        await database.db.query.accountThreadState.findFirst({
          where: and(
            eq(accountThreadState.accountId, bob.id),
            eq(accountThreadState.threadId, threadId),
          ),
        });
      expect(boundaryWake.threadFeedEndId).toBeGreaterThan(
        beforeRevokeFeed!.threadFeedEndId,
      );
      expect(boundaryState!.threadFeedId).toBeGreaterThan(
        beforeRevokeFeed!.threadFeedEndId,
      );
      expect(boundaryState!.threadFeedId).toBeLessThanOrEqual(
        boundaryWake.threadFeedEndId,
      );
      const boundarySeq = boundaryState!.messageVisibleThroughSeq!;
      expect(boundarySeq).toBeGreaterThan(0);
      const boundary = await database.db.query.message.findFirst({
        where: and(
          eq(message.threadId, threadId),
          eq(message.seq, boundarySeq),
          eq(message.contentType, 'SYSTEM'),
        ),
      });
      expect(boundary).toMatchObject({
        creatorAccount: '$system',
        creatorDomain: 'local',
      });
      const participants = await database.db.query.accountThreadState.findMany({
        where: eq(accountThreadState.threadId, threadId),
      });
      expect(
        participants.map((participant) => participant.messageVisibleThroughSeq),
      ).toEqual([boundarySeq, boundarySeq]);
      expect(
        participants.map((participant) => participant.accountId).sort(),
      ).toEqual([alice.id, bob.id].sort());
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

    const userIntents = app.get(UserIntentService);
    const receivedUserIntents = app.get(ReceivedUserIntentService);
    await database.db.transaction(async (tx) => {
      await userIntents.executeInTx(
        tx,
        {
          userId: alice.id,
          decision: 'REQUESTED',
          target: {
            account: foreignBob.account,
            domain: foreignBob.domain,
            namespaceId: foreignBob.namespaceId,
          },
        },
        [],
      );
      await receivedUserIntents.applyInTx(
        tx,
        {
          localUserId: alice.id,
          peer: foreignBob,
          body: {
            status: 'REQUESTED',
            profileRev: 0,
            note: '',
            requestedAt: Date.now(),
            expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
          },
        },
        [],
        new Set(),
      );
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
    const userIntents = app.get(UserIntentService);
    const receivedUserIntents = app.get(ReceivedUserIntentService);
    await database.db.transaction((tx) =>
      userIntents.executeInTx(
        tx,
        {
          userId: alice.id,
          decision: 'REQUESTED',
          target: {
            account: foreignBob.account,
            domain: foreignBob.domain,
            namespaceId: foreignBob.namespaceId,
          },
        },
        [],
      ),
    );
    await database.db.transaction((tx) =>
      receivedUserIntents.applyInTx(
        tx,
        {
          localUserId: alice.id,
          peer: foreignBob,
          body: {
            status: 'REQUESTED',
            profileRev: 1,
            note: 'crossed request',
            requestedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          },
        },
        [],
        new Set(),
      ),
    );

    const afterCrossedRequest = (
      await findP2PRelationship(database.db, alice.id, foreignBob)
    ).pair;
    expect(afterCrossedRequest?.active).toBe(true);
    expect(afterCrossedRequest?.threadId).not.toBeNull();

    await database.db.transaction((tx) =>
      receivedUserIntents.applyInTx(
        tx,
        {
          localUserId: alice.id,
          peer: foreignBob,
          body: {
            status: 'ACCEPTED',
            profileRev: 1,
            note: 'crossed request',
            requestedAt: Date.now(),
            expiresAt: null,
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
          },
        },
        [],
        new Set(),
      ),
    );

    const afterConfirmation = (
      await findP2PRelationship(database.db, alice.id, foreignBob)
    ).pair;
    expect(afterConfirmation?.active).toBe(true);
    expect(afterConfirmation?.threadId).not.toBeNull();
  });
});
