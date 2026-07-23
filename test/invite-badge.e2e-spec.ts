import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';
import { InviteService } from '../src/invite/invite.service';
import { seedUserWithSession } from './seed';

/**
 * Friend-request badge — the BACKEND half of the data contract.
 *
 * The badge is now DERIVED: the client compares the SSE HELLO/push-carried `friendReqRev` (= MAX(updatedAt)
 * over the user's incoming FRIEND invites — a monotonic, data-derived revision) to its IDB cursor, mirroring
 * the threadRevision delta model. There is no denormalized boolean column; a FRIEND invite advances
 * friendReqRev simply by being created (its own `updatedAt`). This spec pins the server side of that
 * contract: a FRIEND invite advances the recipient's derived friendReqRev, and markRead is a client-side
 * concern (a no-op server-side — the badge clears by advancing the client cursor, not by mutating state).
 *
 * Scope note: this guards the derived revision the client reads, NOT the client's cursor/badge derivation
 * (that lives in web/src/app/services/user.service.spec.ts) nor the live FRIEND_REQ_REV_UPDATED push (an SSE
 * integration, asserted separately). Keep all three: this anchors the derivation + markRead no-op.
 */
describe('Friend-request badge e2e (invite advances derived friendReqRev; mark-read is a no-op)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
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
    prisma = app.get(PrismaService);
    invites = app.get(InviteService);
  });

  beforeEach(async () => {
    // Isolate every run: truncating User CASCADE-clears Invite, RefreshToken, threads, etc.
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await app.close();
  });

  it('a FRIEND invite advances the recipient derived friendReqRev, and markRead is a server no-op', async () => {
    const http = app.getHttpServer();

    // 1+2. Seed inviter A + invitee B with sessions directly (registration is closed; the spec needs two
    // authenticated users, not the login flow).
    const tokA = (await seedUserWithSession(app, 'inviter', { name: 'Inviter' })).token;
    const tokB = (await seedUserWithSession(app, 'invitee', { name: 'Invitee' })).token;
    expect(tokA).toBeTruthy();
    expect(tokB).toBeTruthy();
    const authA = { Authorization: `Bearer ${tokA}` };
    const authB = { Authorization: `Bearer ${tokB}` };

    const inviteeId = (
      await request(http).post('/api/v1/user/my-profile').set(authB)
    ).body.data.id;

    // 3. baseline: B has no incoming FRIEND invites → friendReqRev is null
    expect(await invites.findLatestFriendReqUpdate(inviteeId)).toBeNull();

    // 4. A invites B → the PENDING row's creation advances MAX(updatedAt) over B's incoming FRIEND invites
    const invite = await request(http)
      .post('/api/v1/invite/friend')
      .set(authA)
      .send({ toUserId: inviteeId });
    expect(invite.body.code).toBe(0);

    // 5. B's derived friendReqRev is now a positive epoch-ms timestamp
    const armed = await invites.findLatestFriendReqUpdate(inviteeId);
    expect(typeof armed).toBe('number');
    expect(armed!).toBeGreaterThan(0);

    // 6. markRead is a CLIENT-side cursor advance — a server no-op (no state to clear). friendReqRev is
    //    unchanged after it; the badge clears because the client advances its own cursor, not because the
    //    server mutated anything.
    const mark = await request(http).post('/api/v1/invite/mark-read').set(authB);
    expect(mark.body.code).toBe(0);
    expect(await invites.findLatestFriendReqUpdate(inviteeId)).toBe(armed);
  });
});
