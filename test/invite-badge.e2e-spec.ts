import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';

/**
 * Friend-request unread badge — the BACKEND half of the badge data contract.
 *
 * The frontend renders the red dot off `sessionProfile().hasUrFriendReq`, refreshed live via
 * updateSessionProfile() when a NOTIFY FRIEND_REQUEST arrives. This spec pins the server side of
 * that contract: a FRIEND invite arms `hasUrFriendReq` on the recipient, and markInvitesRead
 * clears it. It is a direct, persisted transcription of the manual register→invite→assert flow
 * that diagnosed the 2026-07-12 badge regression.
 *
 * Scope note: this test guards the data the client reads, NOT the client re-fetch. The actual
 * regression (updateSessionProfile short-circuiting via a non-force ensureProfile, so the live
 * badge never armed) is a FRONTEND bug — the backend here returned hasUrFriendReq correctly the
 * whole time. That client-side guard lives in web/src/app/services/user.service.spec.ts. Keep both:
 * this one anchors the API contract, that one anchors the force-refresh.
 */
describe('Friend-request badge e2e (invite arms hasUrFriendReq; mark-read clears it)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

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
  });

  beforeEach(async () => {
    // Isolate every run: truncating User CASCADE-clears Invite, RefreshToken, threads, etc.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "User" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('a FRIEND invite arms the recipient badge, and markInvitesRead clears it', async () => {
    const http = app.getHttpServer();

    // 1. register inviter A + invitee B
    const regA = await request(http)
      .post('/api/v1/user/register')
      .send({ account: 'inviter', name: 'Inviter', password: 'Pass1234' });
    expect(regA.body.code).toBe(0);
    const regB = await request(http)
      .post('/api/v1/user/register')
      .send({ account: 'invitee', name: 'Invitee', password: 'Pass1234' });
    expect(regB.body.code).toBe(0);

    // 2. login both → access tokens
    const tokA = (
      await request(http).post('/api/v1/auth/login').send({ account: 'inviter', password: 'Pass1234' })
    ).body.data.access_token;
    const tokB = (
      await request(http).post('/api/v1/auth/login').send({ account: 'invitee', password: 'Pass1234' })
    ).body.data.access_token;
    expect(tokA).toBeTruthy();
    expect(tokB).toBeTruthy();
    const authA = { Authorization: `Bearer ${tokA}` };
    const authB = { Authorization: `Bearer ${tokB}` };

    // 3. baseline: B has no pending badge
    const before = await request(http).post('/api/v1/user/my-profile').set(authB);
    expect(before.body.code).toBe(0);
    expect(before.body.data.hasUrFriendReq).toBe(false);
    const inviteeId = before.body.data.id;

    // 4. A invites B → arms the badge server-side (and would push NOTIFY FRIEND_REQUEST live)
    const invite = await request(http)
      .post('/api/v1/invite/friend')
      .set(authA)
      .send({ toUserId: inviteeId });
    expect(invite.body.code).toBe(0);

    // 5. B's profile now reports the armed badge — the data updateSessionProfile() re-fetches
    const armed = await request(http).post('/api/v1/user/my-profile').set(authB);
    expect(armed.body.data.hasUrFriendReq).toBe(true);

    // 6. B opens the friend-requests panel → markInvitesRead clears the badge
    const mark = await request(http).post('/api/v1/invite/mark-read').set(authB);
    expect(mark.body.code).toBe(0);
    const cleared = await request(http).post('/api/v1/user/my-profile').set(authB);
    expect(cleared.body.data.hasUrFriendReq).toBe(false);
  });
});
