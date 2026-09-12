import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/database/database.service';
import { RelationshipService } from '../src/relationship/relationship.service';
import {
  account,
  durableTask,
  relationshipIntent,
  account as user,
} from '../src/database/schema';
import { and, eq } from 'drizzle-orm';
import {
  findP2PRelationship,
  seedFederatedPeerNamespace,
  seedUserWithSession,
} from './seed';
import {
  waitForDurableTask,
  waitForLocalRelationshipRequest,
} from './durable-task-helpers.js';

/**
 * Friend-request badge — the BACKEND half of the data contract.
 *
 * A new incoming request advances the recipient's Client State Feed and appears as a compacted
 * relationship-request operation. Reading is a device-local client cursor and has no server endpoint/state.
 */
describe('Friend-request client state e2e', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let relationships: RelationshipService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // Plain Fastify adapter configured exactly like production. No explicit app.init(): setGlobalPrefix
    // must run before routes register, and listen() performs init + route registration + Fastify ready().
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
    relationships = app.get(RelationshipService);
  });

  beforeEach(async () => {
    // Isolate every run: truncating User CASCADE-clears Invite, RefreshToken, threads, etc.
    await database.pool.query(
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('a relationship request advances the Client State Feed and emits an incoming request delta', async () => {
    const http = app.getHttpServer();

    // 1+2. Seed inviter A + invitee B with sessions directly (registration is closed; the spec needs two
    // authenticated users, not the login flow).
    const inviter = await seedUserWithSession(app, 'inviter', {
      name: 'Inviter',
    });
    const invitee = await seedUserWithSession(app, 'invitee', {
      name: 'Invitee',
    });
    const tokA = inviter.token;
    const tokB = invitee.token;
    expect(tokA).toBeTruthy();
    expect(tokB).toBeTruthy();
    const authA = { Authorization: `Bearer ${tokA}` };
    const authB = { Authorization: `Bearer ${tokB}` };

    const inviteeId = (
      await request(http).post('/api/v1/user/my-profile').set(authB)
    ).body.data.id;

    const before = await database.db.query.account.findFirst({
      where: eq(account.id, inviteeId),
      columns: { stateFeedEndId: true },
    });
    expect(before).toBeDefined();

    // 4. A invites B → the PENDING row's creation advances MAX(updatedAt) over B's incoming FRIEND invites
    const invite = await request(http)
      .post('/api/v1/relationship/request')
      .set(authA)
      .send({ account: 'invitee', domain: 'local' });
    expect(invite.body.code).toBe(0);
    await waitForLocalRelationshipRequest(
      database.db,
      invite.body.data.taskId,
      inviter.id,
      invitee.id,
    );

    const after = await database.db.query.account.findFirst({
      where: eq(account.id, inviteeId),
      columns: { stateFeedEndId: true },
    });
    // The compacted client intent itself drives the device-local notification watermark.
    expect(after!.stateFeedEndId).toBe(before!.stateFeedEndId + 1);

    const delta = await request(http)
      .get('/api/v1/user/state-feed')
      .set(authB)
      .query({
        mode: 'delta',
        after: before!.stateFeedEndId,
        through: after!.stateFeedEndId,
      });
    expect(delta.body.code).toBe(0);
    expect(delta.body.data.items).toContainEqual(
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

    const beforeInvalidAccept = await database.db
      .select({ id: durableTask.id })
      .from(durableTask);
    const invalidAccept = await request(http)
      .post('/api/v1/relationship/accept')
      .set(authA)
      .send({ account: 'invitee', domain: 'local' });
    expect(invalidAccept.body.code).toBe(20010);
    expect(
      await database.db.select({ id: durableTask.id }).from(durableTask),
    ).toHaveLength(beforeInvalidAccept.length);

    const accepted = await request(http)
      .post('/api/v1/relationship/accept')
      .set(authB)
      .send({ account: 'inviter', domain: 'local' });
    expect(accepted.body.code).toBe(0);
    expect(accepted.body.data).toMatchObject({ status: 'PENDING' });
    await waitForDurableTask(database.db, accepted.body.data.taskId);
    const acceptedHead = await database.db.query.account.findFirst({
      where: eq(account.id, inviteeId),
      columns: { stateFeedEndId: true },
    });
    const handledDelta = await request(http)
      .get('/api/v1/user/state-feed')
      .set(authB)
      .query({
        mode: 'delta',
        after: after!.stateFeedEndId,
        through: acceptedHead!.stateFeedEndId,
      });
    expect(handledDelta.body.data.items).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          direction: 'INCOMING',
          status: 'ACCEPTED',
        }),
      }),
    );
  });

  it('atomically confirms two expired directions after both sides renew', async () => {
    const a = await seedUserWithSession(app, 'expired-a', { name: 'A' });
    const peerDomain = 'peer.test';
    const namespaceId = await seedFederatedPeerNamespace(
      database.db,
      peerDomain,
    );
    const b = { account: 'expired-b', domain: peerDomain, namespaceId };
    const pastRequestedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const pastExpiresAt = new Date(
      pastRequestedAt.getTime() + 6 * 24 * 60 * 60 * 1000,
    );

    await database.db.transaction((tx) =>
      relationships.writeLocalP2PIntentInTx(tx, a.id, b, true),
    );
    const relationship = await findP2PRelationship(database.db, a.id, b);
    await database.db.transaction(async (tx) => {
      await tx
        .update(relationshipIntent)
        .set({ requestedAt: pastRequestedAt, expiresAt: pastExpiresAt })
        .where(
          and(
            eq(relationshipIntent.pairId, relationship.pair!.id),
            eq(relationshipIntent.authorSide, relationship.firstSide),
          ),
        );
      await relationships.applyRemoteP2PIntentInTx(tx, {
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        localUserId: a.id,
        peerUserId: b,
        status: 'REQUESTED',
        profileRev: 0,
        note: 'arrived too late',
        requestedAt: pastRequestedAt,
        expiresAt: pastExpiresAt,
        origin: peerDomain,
      });
    });

    let pair = (await findP2PRelationship(database.db, a.id, b)).pair;
    expect(pair?.active).toBe(false);
    expect(pair?.threadId).not.toBeNull();

    await database.db.transaction(async (tx) => {
      // The same explicit request must renew an expired direction even when status and note are
      // unchanged. It refreshes its expiry, but cannot activate while the peer direction is expired.
      await relationships.writeLocalP2PIntentInTx(tx, a.id, b, true);
    });
    const renewedLocal = await database.db.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.pairId, relationship.pair!.id),
        eq(relationshipIntent.authorSide, relationship.firstSide),
      ),
    });
    expect(renewedLocal?.expiresAt?.getTime()).toBeGreaterThan(Date.now());

    pair = (await findP2PRelationship(database.db, a.id, b)).pair;
    expect(pair?.active).toBe(false);

    await database.db.transaction(async (tx) => {
      const now = new Date();
      await relationships.applyRemoteP2PIntentInTx(tx, {
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        localUserId: a.id,
        peerUserId: b,
        status: 'REQUESTED',
        profileRev: 0,
        note: 'renewed',
        requestedAt: now,
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        origin: peerDomain,
      });
    });

    pair = (await findP2PRelationship(database.db, a.id, b)).pair;
    // Applying the peer-owned renewed request promotes only the effective local request. Crossed
    // requests are already confirmed while the peer-owned direction remains REQUESTED.
    expect(pair?.active).toBe(true);
    expect(pair?.threadId).not.toBeNull();

    await database.db.transaction((tx) =>
      relationships.applyRemoteP2PIntentInTx(tx, {
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        localUserId: a.id,
        peerUserId: b,
        status: 'ACCEPTED',
        profileRev: 0,
        note: 'renewed',
        requestedAt: new Date(),
        expiresAt: null,
        origin: peerDomain,
      }),
    );
    pair = (await findP2PRelationship(database.db, a.id, b)).pair;
    expect(pair?.active).toBe(true);
    expect(pair?.threadId).not.toBeNull();
  });

  it('shows a new reverse request after my old direction expired and acceptance renews it atomically', async () => {
    const a = await seedUserWithSession(app, 'reverse-expired-a', {
      name: 'A',
    });
    const b = await seedUserWithSession(app, 'reverse-expired-b', {
      name: 'B',
    });
    const authA = { Authorization: `Bearer ${a.token}` };
    const authB = { Authorization: `Bearer ${b.token}` };

    const old = await request(app.getHttpServer())
      .post('/api/v1/relationship/request')
      .set(authA)
      .send({ account: b.account, domain: 'local', note: 'old A to B' });
    expect(old.body.code).toBe(0);
    await waitForLocalRelationshipRequest(
      database.db,
      old.body.data.taskId,
      a.id,
      b.id,
    );
    const expiredAt = Date.now();
    const relationship = await findP2PRelationship(database.db, a.id, b.id);
    await database.db
      .update(relationshipIntent)
      .set({
        requestedAt: new Date(expiredAt - 8 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(expiredAt - 24 * 60 * 60 * 1000),
      })
      .where(
        and(
          eq(relationshipIntent.pairId, relationship.pair!.id),
          eq(relationshipIntent.authorSide, relationship.firstSide),
        ),
      );

    const reverse = await request(app.getHttpServer())
      .post('/api/v1/relationship/request')
      .set(authB)
      .send({ account: a.account, domain: 'local', note: 'new B to A' });
    expect(reverse.body.code).toBe(0);
    await waitForLocalRelationshipRequest(
      database.db,
      reverse.body.data.taskId,
      b.id,
      a.id,
    );
    let pair = (await findP2PRelationship(database.db, a.id, b.id)).pair;
    expect(pair?.active).toBe(false);

    const incoming = await database.db.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.pairId, pair!.id),
        eq(
          relationshipIntent.authorSide,
          relationship.firstSide === 'A' ? 'B' : 'A',
        ),
      ),
    });
    expect(incoming).toMatchObject({
      note: 'new B to A',
      status: 'REQUESTED',
    });

    const accepted = await request(app.getHttpServer())
      .post('/api/v1/relationship/accept')
      .set(authA)
      .send({ account: b.account, domain: 'local' });
    expect(accepted.body.code).toBe(0);
    expect(accepted.body.data).toMatchObject({ status: 'PENDING' });
    await waitForDurableTask(database.db, accepted.body.data.taskId);

    const directions = await database.db.query.relationshipIntent.findMany({
      where: and(
        eq(relationshipIntent.pairId, relationship.pair!.id),
        eq(relationshipIntent.authorSide, relationship.firstSide),
      ),
    });
    expect(directions[0]?.status).toBe('ACCEPTED');
    pair = (await findP2PRelationship(database.db, a.id, b.id)).pair;
    expect(pair?.active).toBe(true);
    expect(pair?.threadId).toBeTypeOf('number');
  });

  it('rejects an unrelated Address and executes an incoming revoke asynchronously', async () => {
    const sender = await seedUserWithSession(app, 'reject-sender');
    const recipient = await seedUserWithSession(app, 'reject-recipient');
    const stranger = await seedUserWithSession(app, 'reject-stranger');
    const sent = await request(app.getHttpServer())
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({ account: recipient.account, domain: 'local' });
    await waitForLocalRelationshipRequest(
      database.db,
      sent.body.data.taskId,
      sender.id,
      recipient.id,
    );

    const beforeInvalid = await database.db
      .select({ id: durableTask.id })
      .from(durableTask);
    const invalid = await request(app.getHttpServer())
      .post('/api/v1/relationship/revoke')
      .set('Authorization', `Bearer ${stranger.token}`)
      .send({ account: sender.account, domain: 'local' });
    expect(invalid.body.code).toBe(20002);
    expect(
      await database.db.select({ id: durableTask.id }).from(durableTask),
    ).toHaveLength(beforeInvalid.length);

    const rejected = await request(app.getHttpServer())
      .post('/api/v1/relationship/revoke')
      .set('Authorization', `Bearer ${recipient.token}`)
      .send({ account: sender.account, domain: 'local' });
    expect(rejected.body).toMatchObject({
      code: 0,
      data: { status: 'PENDING' },
    });
    await waitForDurableTask(database.db, rejected.body.data.taskId);

    const relationship = await findP2PRelationship(
      database.db,
      recipient.id,
      sender.id,
    );
    const reverse = await database.db.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.pairId, relationship.pair!.id),
        eq(relationshipIntent.authorSide, relationship.firstSide),
      ),
      columns: { status: true },
    });
    expect(reverse?.status).toBe('REVOKED');
  });

  it('queues and executes an outgoing local request revoke by Address', async () => {
    const sender = await seedUserWithSession(app, 'revoke-sender');
    const recipient = await seedUserWithSession(app, 'revoke-recipient');
    const sent = await request(app.getHttpServer())
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({ account: recipient.account, domain: 'local' });
    await waitForLocalRelationshipRequest(
      database.db,
      sent.body.data.taskId,
      sender.id,
      recipient.id,
    );

    const revoked = await request(app.getHttpServer())
      .post('/api/v1/relationship/revoke')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({ account: recipient.account, domain: 'local' });
    expect(revoked.body).toMatchObject({
      code: 0,
      data: { status: 'PENDING' },
    });
    await waitForDurableTask(database.db, revoked.body.data.taskId);

    const relationship = await findP2PRelationship(
      database.db,
      sender.id,
      recipient.id,
    );
    const authored = await database.db.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.pairId, relationship.pair!.id),
        eq(relationshipIntent.authorSide, relationship.firstSide),
      ),
      columns: { status: true },
    });
    expect(authored?.status).toBe('REVOKED');
  });
});
