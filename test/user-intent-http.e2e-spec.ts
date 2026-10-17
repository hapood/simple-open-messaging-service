import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq, or } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service';
import * as tables from '../src/database/schema';
import { BusinessCode } from '../src/common/business-code';
import { findP2PRelationship, seedUserWithSession } from './seed';
import { createTestApp } from './support/app';
import { truncateTablesForTest } from './support/truncate';

/**
 * HTTP contract of the synchronous P2P user-intent family (business): the
 * controller answer, the client state-feed deltas, and the error codes.
 */
describe('User intent HTTP contract e2e', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;

  beforeAll(async () => {
    ({ app, database } = await createTestApp());
  });

  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread", "RelationshipPair", "RelationshipIntent", "Message", "ThreadAudience" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function stateFeedEndId(userId: number): Promise<number> {
    const row = await database.db.query.account.findFirst({
      where: eq(tables.account.id, userId),
      columns: { clientStateFeedEndId: true },
    });
    return row!.clientStateFeedEndId;
  }

  async function feedDelta(
    token: string,
    userId: number,
    after: number,
    through: number,
  ) {
    const delta = await request(app.getHttpServer())
      .get('/api/v1/user/state-feed')
      .set(auth(token))
      .query({ mode: 'delta', after, through });
    expect(delta.body.code).toBe(0);
    return delta.body.data.items as Array<{
      account: string;
      eventType: string;
      subjectAccount: string;
      body: Record<string, unknown>;
    }>;
  }

  async function pendingIntentStatus(
    ownerId: number,
    peerAccount: string,
  ): Promise<{ status: string; requestedAt: Date; expiresAt: Date } | null> {
    const { pair, firstEndpoint } = await findP2PRelationship(
      database.db,
      ownerId,
      {
        account: peerAccount,
        namespaceId: 0,
      },
    );
    if (!pair) return null;
    const rows = await database.db.query.relationshipIntent.findMany({
      where: and(
        eq(tables.relationshipIntent.authorAccount, firstEndpoint.account),
        eq(
          tables.relationshipIntent.authorNamespaceId,
          firstEndpoint.namespaceId,
        ),
      ),
    });
    const row = rows[0];
    return row
      ? {
          status: row.status,
          requestedAt: row.requestedAt!,
          expiresAt: row.expiresAt!,
        }
      : null;
  }

  it('advances the recipient feed synchronously and emits the incoming request delta', async () => {
    const http = app.getHttpServer();
    const inviter = await seedUserWithSession(app, 'inviter', {
      name: 'Inviter',
    });
    const invitee = await seedUserWithSession(app, 'invitee', {
      name: 'Invitee',
    });
    const before = await stateFeedEndId(invitee.id);

    // The command is synchronous: the committed feed delta is visible the
    // moment the request answers, with no task indirection.
    const invite = await request(http)
      .post('/api/v1/relationship/request')
      .set(auth(inviter.token))
      .send({
        account: 'invitee',
        namespaceId: 0,
      });
    expect(invite.body.code).toBe(0);
    expect(invite.body.data).toEqual({ status: 'OK' });

    expect(await stateFeedEndId(invitee.id)).toBe(before + 1);
    const items = await feedDelta(
      invitee.token,
      invitee.id,
      before,
      before + 1,
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        account: 'inviter',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: 'invitee',
        body: expect.objectContaining({
          direction: 'INCOMING',
          status: 'REQUESTED',
        }),
      }),
    );
  });

  it('rejects a self-directed acceptance with the stable invite code', async () => {
    const http = app.getHttpServer();
    const inviter = await seedUserWithSession(app, 'inviter', { name: 'A' });
    const _invitee = await seedUserWithSession(app, 'invitee', { name: 'B' });
    await request(http)
      .post('/api/v1/relationship/request')
      .set(auth(inviter.token))
      .send({
        account: 'invitee',
        namespaceId: 0,
      });

    // Only the recipient of a live incoming direction may accept it.
    const invalidAccept = await request(http)
      .post('/api/v1/relationship/accept')
      .set(auth(inviter.token))
      .send({
        account: 'invitee',
        namespaceId: 0,
      });
    expect(invalidAccept.body.code).toBe(BusinessCode.INVITE_NOT_FOUND);
  });

  it('activates on the recipient accept, returns the thread, and publishes the acceptance fact', async () => {
    const http = app.getHttpServer();
    const inviter = await seedUserWithSession(app, 'inviter', { name: 'A' });
    const invitee = await seedUserWithSession(app, 'invitee', { name: 'B' });
    await request(http)
      .post('/api/v1/relationship/request')
      .set(auth(inviter.token))
      .send({
        account: 'invitee',
        namespaceId: 0,
      });
    const afterRequest = await stateFeedEndId(invitee.id);

    const accepted = await request(http)
      .post('/api/v1/relationship/accept')
      .set(auth(invitee.token))
      .send({
        account: 'inviter',
        namespaceId: 0,
      });
    expect(accepted.body.code).toBe(0);
    expect(accepted.body.data).toMatchObject({ status: 'OK' });
    expect(typeof accepted.body.data.threadId).toBe('number');

    const { pair } = await findP2PRelationship(database.db, inviter.id, {
      account: 'invitee',
      namespaceId: 0,
    });
    expect(pair?.active).toBe(true);
    expect(pair?.threadId).toBe(accepted.body.data.threadId);

    const items = await feedDelta(
      invitee.token,
      invitee.id,
      afterRequest,
      await stateFeedEndId(invitee.id),
    );
    // The compacted row carries the acceptance fact from the reader's own
    // viewpoint: their authored direction won the compaction, so the reader
    // sees their own OUTGOING acceptance with the established thread.
    expect(items).toContainEqual(
      expect.objectContaining({
        account: 'inviter',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: 'invitee',
        body: expect.objectContaining({
          status: 'ACCEPTED',
          established: true,
          localThreadId: accepted.body.data.threadId,
        }),
      }),
    );
    // Compaction: the pair's projection for the reader carries the acceptance
    // fact — an ACCEPTED, established row exists beside the per-direction
    // views, merged client-side by direction and feed id.
    // Table columns name the PEER as `account` and the reader as `subject`.
    const intents = await database.db.query.clientStateFeed.findMany({
      where: and(
        eq(tables.clientStateFeed.userId, invitee.id),
        eq(tables.clientStateFeed.eventType, 'RELATIONSHIP_INTENT'),
        eq(tables.clientStateFeed.account, 'inviter'),
        eq(tables.clientStateFeed.subjectAccount, 'invitee'),
      ),
    });
    expect(intents.length).toBeGreaterThan(0);
    // `body` is a jsonb column, so drizzle infers `{}` — read it as the
    // RELATIONSHIP_INTENT payload shape the writer emits.
    const bodyOf = (intent: (typeof intents)[number]) =>
      intent.body as { status?: string; established?: boolean } | null;
    expect(
      intents.some(
        (intent) =>
          bodyOf(intent)?.status === 'ACCEPTED' &&
          bodyOf(intent)?.established === true,
      ),
    ).toBe(true);
  });

  it('returns FRIEND_NOT_FOUND for a stranger revocation', async () => {
    const http = app.getHttpServer();
    const _inviter = await seedUserWithSession(app, 'inviter', { name: 'A' });
    const stranger = await seedUserWithSession(app, 'stranger', { name: 'C' });

    const revoked = await request(http)
      .post('/api/v1/relationship/revoke')
      .set(auth(stranger.token))
      .send({
        account: 'inviter',
        namespaceId: 0,
      });
    expect(revoked.body.code).toBe(BusinessCode.FRIEND_NOT_FOUND);
  });

  it('withdrawing a pending request revokes the authored intent without departure and renews on re-request', async () => {
    const http = app.getHttpServer();
    const inviter = await seedUserWithSession(app, 'inviter', { name: 'A' });
    const _invitee = await seedUserWithSession(app, 'invitee', { name: 'B' });
    await request(http)
      .post('/api/v1/relationship/request')
      .set(auth(inviter.token))
      .send({
        account: 'invitee',
        namespaceId: 0,
      });

    const withdrawn = await request(http)
      .post('/api/v1/relationship/revoke')
      .set(auth(inviter.token))
      .send({
        account: 'invitee',
        namespaceId: 0,
      });
    expect(withdrawn.body.code).toBe(0);
    expect(withdrawn.body.data).toEqual({ status: 'OK' });

    const { pair } = await findP2PRelationship(database.db, inviter.id, {
      account: 'invitee',
      namespaceId: 0,
    });
    expect(pair?.active).toBe(false);
    // A withdrawal is not a departure: the shell carries no system history.
    const messages = await database.db.query.message.findMany({
      where: eq(tables.message.threadId, pair!.threadId!),
    });
    expect(messages).toHaveLength(0);

    // Re-application renews the same intent row with a fresh 7-day window.
    const renewed = await request(http)
      .post('/api/v1/relationship/request')
      .set(auth(inviter.token))
      .send({
        account: 'invitee',
        namespaceId: 0,
      });
    expect(renewed.body.code).toBe(0);
    expect(renewed.body.data).toEqual({ status: 'OK' });
    const intent = await pendingIntentStatus(inviter.id, 'invitee');
    expect(intent?.status).toBe('REQUESTED');
    expect(intent!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(intent!.expiresAt.getTime() - intent!.requestedAt.getTime()).toEqual(
      7 * 24 * 60 * 60 * 1000,
    );
  });

  it('rejecting an incoming request keeps the requester pending and re-application alive', async () => {
    const http = app.getHttpServer();
    const inviter = await seedUserWithSession(app, 'inviter', { name: 'A' });
    const invitee = await seedUserWithSession(app, 'invitee', { name: 'B' });
    await request(http)
      .post('/api/v1/relationship/request')
      .set(auth(inviter.token))
      .send({
        account: 'invitee',
        namespaceId: 0,
      });

    const rejected = await request(http)
      .post('/api/v1/relationship/revoke')
      .set(auth(invitee.token))
      .send({
        account: 'inviter',
        namespaceId: 0,
      });
    expect(rejected.body.code).toBe(0);

    // Rejection revokes the recipient side; the requester stays pending and
    // may re-apply.
    expect((await pendingIntentStatus(inviter.id, 'invitee'))?.status).toBe(
      'REQUESTED',
    );
    const reApplied = await request(http)
      .post('/api/v1/relationship/request')
      .set(auth(inviter.token))
      .send({
        account: 'invitee',
        namespaceId: 0,
      });
    expect(reApplied.body.code).toBe(0);
    expect(reApplied.body.data).toEqual({ status: 'OK' });
    expect((await pendingIntentStatus(inviter.id, 'invitee'))?.status).toBe(
      'REQUESTED',
    );
  });

  it('renews an expired direction on re-request and collapses a live reverse request into activation', async () => {
    const http = app.getHttpServer();
    const inviter = await seedUserWithSession(app, 'inviter', { name: 'A' });
    const invitee = await seedUserWithSession(app, 'invitee', { name: 'B' });
    await request(http)
      .post('/api/v1/relationship/request')
      .set(auth(inviter.token))
      .send({
        account: 'invitee',
        namespaceId: 0,
      });

    // Expire the pending direction behind the command's back.
    const { firstEndpoint, secondEndpoint } = await findP2PRelationship(
      database.db,
      inviter.id,
      {
        account: 'invitee',
        namespaceId: 0,
      },
    );
    await database.db
      .update(tables.relationshipIntent)
      .set({
        requestedAt: new Date(Date.now() - 8000),
        expiresAt: new Date(Date.now() - 1000),
      })
      .where(
        or(
          and(
            eq(tables.relationshipIntent.authorAccount, firstEndpoint.account),
            eq(
              tables.relationshipIntent.authorNamespaceId,
              firstEndpoint.namespaceId,
            ),
            eq(
              tables.relationshipIntent.receiverAccount,
              secondEndpoint.account,
            ),
            eq(
              tables.relationshipIntent.receiverNamespaceId,
              secondEndpoint.namespaceId,
            ),
          ),
          and(
            eq(tables.relationshipIntent.authorAccount, secondEndpoint.account),
            eq(
              tables.relationshipIntent.authorNamespaceId,
              secondEndpoint.namespaceId,
            ),
            eq(
              tables.relationshipIntent.receiverAccount,
              firstEndpoint.account,
            ),
            eq(
              tables.relationshipIntent.receiverNamespaceId,
              firstEndpoint.namespaceId,
            ),
          ),
        ),
      );

    // The identical request renews the window but cannot self-activate.
    const renewed = await request(http)
      .post('/api/v1/relationship/request')
      .set(auth(inviter.token))
      .send({
        account: 'invitee',
        namespaceId: 0,
      });
    expect(renewed.body.code).toBe(0);
    expect(renewed.body.data).toEqual({ status: 'OK' });
    expect((await pendingIntentStatus(inviter.id, 'invitee'))?.status).toBe(
      'REQUESTED',
    );
    const refreshed = await findP2PRelationship(database.db, inviter.id, {
      account: 'invitee',
      namespaceId: 0,
    });
    expect(refreshed.pair?.active).toBe(false);

    // A live reverse request crosses into the acceptance path: both sides
    // learn FRIEND through the returned thread id.
    const crossed = await request(http)
      .post('/api/v1/relationship/request')
      .set(auth(invitee.token))
      .send({
        account: 'inviter',
        namespaceId: 0,
      });
    expect(crossed.body.code).toBe(0);
    expect(typeof crossed.body.data.threadId).toBe('number');
    const activated = await findP2PRelationship(database.db, inviter.id, {
      account: 'invitee',
      namespaceId: 0,
    });
    expect(activated.pair?.active).toBe(true);
  });

  it('returns an expired-intent business result instead of throwing the command', async () => {
    const http = app.getHttpServer();
    const inviter = await seedUserWithSession(app, 'inviter', { name: 'A' });
    await seedUserWithSession(app, 'invitee', { name: 'B' });
    await request(http)
      .post('/api/v1/relationship/request')
      .set(auth(inviter.token))
      .send({
        account: 'invitee',
        namespaceId: 0,
      });
    const { firstEndpoint, secondEndpoint } = await findP2PRelationship(
      database.db,
      inviter.id,
      {
        account: 'invitee',
        namespaceId: 0,
      },
    );
    await database.db
      .update(tables.relationshipIntent)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(
        and(
          eq(tables.relationshipIntent.authorAccount, firstEndpoint.account),
          eq(
            tables.relationshipIntent.authorNamespaceId,
            firstEndpoint.namespaceId,
          ),
          eq(tables.relationshipIntent.receiverAccount, secondEndpoint.account),
          eq(
            tables.relationshipIntent.receiverNamespaceId,
            secondEndpoint.namespaceId,
          ),
        ),
      );

    const response = await request(http)
      .post('/api/v1/relationship/revoke')
      .set(auth(inviter.token))
      .send({
        account: 'invitee',
        namespaceId: 0,
      });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      code: BusinessCode.INVITE_EXPIRED,
      data: { status: 'REJECTED', reason: 'INTENT_EXPIRED' },
    });
  });
});
