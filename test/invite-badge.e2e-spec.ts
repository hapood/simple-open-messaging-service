import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/database/database.service';
import { InviteService } from '../src/invite/invite.service';
import {
  relationshipPair,
  relationshipIntent,
  user,
} from '../src/database/schema';
import { and, eq } from 'drizzle-orm';
import { seedUserWithSession } from './seed';

/**
 * Friend-request badge — the BACKEND half of the data contract.
 *
 * A new incoming request advances the recipient's unified stateRevision and appears as a compacted
 * CLIENT_STATE operation. Reading is a device-local client cursor and has no server endpoint/state.
 */
describe('Friend-request client state e2e', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let invites: InviteService;

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
    invites = app.get(InviteService);
  });

  beforeEach(async () => {
    // Isolate every run: truncating User CASCADE-clears Invite, RefreshToken, threads, etc.
    await database.pool.query('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await app.close();
  });

  it('a FRIEND invite advances unified stateRevision and emits an incoming CLIENT_STATE delta', async () => {
    const http = app.getHttpServer();

    // 1+2. Seed inviter A + invitee B with sessions directly (registration is closed; the spec needs two
    // authenticated users, not the login flow).
    const tokA = (
      await seedUserWithSession(app, 'inviter', { name: 'Inviter' })
    ).token;
    const tokB = (
      await seedUserWithSession(app, 'invitee', { name: 'Invitee' })
    ).token;
    expect(tokA).toBeTruthy();
    expect(tokB).toBeTruthy();
    const authA = { Authorization: `Bearer ${tokA}` };
    const authB = { Authorization: `Bearer ${tokB}` };

    const inviteeId = (
      await request(http).post('/api/v1/user/my-profile').set(authB)
    ).body.data.id;

    const before = await database.db.query.user.findFirst({
      where: eq(user.id, inviteeId),
      columns: { threadRevision: true },
    });
    expect(before).toBeDefined();

    // 4. A invites B → the PENDING row's creation advances MAX(updatedAt) over B's incoming FRIEND invites
    const invite = await request(http)
      .post('/api/v1/invite/friend')
      .set(authA)
      .send({ toUserId: inviteeId });
    expect(invite.body.code).toBe(0);

    const after = await database.db.query.user.findFirst({
      where: eq(user.id, inviteeId),
      columns: { threadRevision: true },
    });
    // The compacted client intent itself drives the device-local notification watermark.
    expect(after!.threadRevision).toBe(before!.threadRevision + 1);

    const delta = await request(http)
      .post('/api/v1/user/query-state/delta')
      .set(authB)
      .send({
        fromRevision: before!.threadRevision,
        toRevision: after!.threadRevision,
      });
    expect(delta.body.code).toBe(0);
    expect(delta.body.data).toContainEqual(
      expect.objectContaining({
        direction: 'CLIENT_STATE',
        account: 'inviter',
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: 'invitee',
        body: expect.objectContaining({
          status: 'REQUESTED',
          inviteId: invite.body.data.inviteId,
        }),
      }),
    );

    const accepted = await request(http)
      .post('/api/v1/invite/accept')
      .set(authB)
      .send({ inviteId: invite.body.data.inviteId });
    expect(accepted.body.code).toBe(0);
    const acceptedHead = await database.db.query.user.findFirst({
      where: eq(user.id, inviteeId),
      columns: { threadRevision: true },
    });
    const handledDelta = await request(http)
      .post('/api/v1/user/query-state/delta')
      .set(authB)
      .send({
        fromRevision: after!.threadRevision,
        toRevision: acceptedHead!.threadRevision,
      });
    expect(handledDelta.body.data).toContainEqual(
      expect.objectContaining({
        direction: 'CLIENT_STATE',
        body: expect.objectContaining({ status: 'ACCEPTED' }),
      }),
    );
  });

  it('does not activate two expired directions until both sides renew', async () => {
    const a = await seedUserWithSession(app, 'expired-a', { name: 'A' });
    const b = await seedUserWithSession(app, 'expired-b', { name: 'B' });
    const pastRequestedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const pastExpiresAt = new Date(Date.now() - 24 * 60 * 60 * 1000);

    await database.db.transaction(async (tx) => {
      await invites.writeLocalFriendIntentInTx(tx, a.id, b.id, true);
      await tx
        .update(relationshipIntent)
        .set({ requestedAt: pastRequestedAt, expiresAt: pastExpiresAt })
        .where(
          and(
            eq(relationshipIntent.authorUserId, a.id),
            eq(relationshipIntent.subjectUserId, b.id),
          ),
        );
      await invites.applyRemoteFriendIntentInTx(tx, {
        localUserId: a.id,
        peerUserId: b.id,
        status: 'REQUESTED',
        note: 'arrived too late',
        requestedAt: pastRequestedAt,
        expiresAt: pastExpiresAt,
        origin: 'peer.test',
      });
    });

    let pair = await database.db.query.relationshipPair.findFirst({
      where: and(
        eq(relationshipPair.userLowId, Math.min(a.id, b.id)),
        eq(relationshipPair.userHighId, Math.max(a.id, b.id)),
      ),
    });
    expect(pair?.active).toBe(false);
    expect(pair?.threadId).not.toBeNull();

    await database.db.transaction(async (tx) => {
      // The same explicit request must renew an expired direction even when status and note are
      // unchanged. It refreshes its expiry, but cannot activate while the peer direction is expired.
      await invites.writeLocalFriendIntentInTx(tx, a.id, b.id, true);
    });
    const renewedLocal = await database.db.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.authorUserId, a.id),
        eq(relationshipIntent.subjectUserId, b.id),
      ),
    });
    expect(renewedLocal?.expiresAt?.getTime()).toBeGreaterThan(Date.now());

    pair = await database.db.query.relationshipPair.findFirst({
      where: and(
        eq(relationshipPair.userLowId, Math.min(a.id, b.id)),
        eq(relationshipPair.userHighId, Math.max(a.id, b.id)),
      ),
    });
    expect(pair?.active).toBe(false);

    await database.db.transaction(async (tx) => {
      const now = new Date();
      await invites.applyRemoteFriendIntentInTx(tx, {
        localUserId: a.id,
        peerUserId: b.id,
        status: 'REQUESTED',
        note: 'renewed',
        requestedAt: now,
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        origin: 'peer.test',
      });
    });

    pair = await database.db.query.relationshipPair.findFirst({
      where: and(
        eq(relationshipPair.userLowId, Math.min(a.id, b.id)),
        eq(relationshipPair.userHighId, Math.max(a.id, b.id)),
      ),
    });
    // The peer owns this direction. Its renewed REQUESTED state cannot be
    // promoted locally; activation waits for the peer to synchronize FRIEND.
    expect(pair?.active).toBe(false);
    expect(pair?.threadId).not.toBeNull();

    await database.db.transaction((tx) =>
      invites.applyRemoteFriendIntentInTx(tx, {
        localUserId: a.id,
        peerUserId: b.id,
        status: 'ACCEPTED',
        note: 'renewed',
        requestedAt: new Date(),
        expiresAt: null,
        origin: 'peer.test',
      }),
    );
    pair = await database.db.query.relationshipPair.findFirst({
      where: and(
        eq(relationshipPair.userLowId, Math.min(a.id, b.id)),
        eq(relationshipPair.userHighId, Math.max(a.id, b.id)),
      ),
    });
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
      .post('/api/v1/invite/friend')
      .set(authA)
      .send({ toUserId: b.id, note: 'old A to B' });
    expect(old.body.code).toBe(0);
    await database.db
      .update(relationshipIntent)
      .set({
        requestedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      })
      .where(
        and(
          eq(relationshipIntent.authorUserId, a.id),
          eq(relationshipIntent.subjectUserId, b.id),
        ),
      );

    const reverse = await request(app.getHttpServer())
      .post('/api/v1/invite/friend')
      .set(authB)
      .send({ toUserId: a.id, note: 'new B to A' });
    expect(reverse.body.code).toBe(0);
    let pair = await database.db.query.relationshipPair.findFirst({
      where: and(
        eq(relationshipPair.userLowId, Math.min(a.id, b.id)),
        eq(relationshipPair.userHighId, Math.max(a.id, b.id)),
      ),
    });
    expect(pair?.active).toBe(false);

    const incoming = await request(app.getHttpServer())
      .post('/api/v1/invite/incoming')
      .set(authA);
    expect(incoming.body.code).toBe(0);
    expect(incoming.body.data).toHaveLength(1);
    expect(incoming.body.data[0]).toMatchObject({
      fromUserId: b.id,
      toUserId: a.id,
      note: 'new B to A',
      status: 'PENDING',
    });

    const accepted = await request(app.getHttpServer())
      .post('/api/v1/invite/accept')
      .set(authA)
      .send({ inviteId: incoming.body.data[0].id });
    expect(accepted.body.code).toBe(0);
    expect(accepted.body.data.threadId).toBeTypeOf('number');

    const directions = await database.db.query.relationshipIntent.findMany({
      where: and(
        // This pair is isolated in the test, so either direction is sufficient here.
        eq(relationshipIntent.authorUserId, a.id),
        eq(relationshipIntent.subjectUserId, b.id),
      ),
    });
    expect(directions[0]?.status).toBe('ACCEPTED');
    pair = await database.db.query.relationshipPair.findFirst({
      where: and(
        eq(relationshipPair.userLowId, Math.min(a.id, b.id)),
        eq(relationshipPair.userHighId, Math.max(a.id, b.id)),
      ),
    });
    expect(pair?.active).toBe(true);
    expect(pair?.threadId).toBe(accepted.body.data.threadId);
  });
});
