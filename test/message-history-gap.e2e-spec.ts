import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federationThreadHistoryGap,
  message,
  messageThread,
  accountThreadState,
} from '../src/database/schema.js';
import { ContentType } from '../src/database/enums.js';
import { seedAcceptedRelationship, seedSession, seedUser } from './seed.js';

describe('client message history gaps', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let sessionToken: string;
  let threadId: number;
  let viewerId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread" RESTART IDENTITY CASCADE',
    );
    const viewer = await seedUser(app, 'viewer');
    const peer = await seedUser(app, 'peer');
    viewerId = viewer.id;
    sessionToken = await seedSession(app, viewerId, 'app');
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', curSeq: 50, updatedAt: new Date() })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await seedAcceptedRelationship(database.db, viewerId, peer.id, threadId);
    await database.db.insert(message).values([
      {
        threadId,
        seq: 11,
        originSeq: 1,
        contentType: ContentType.PURE_TEXT,
        content: JSON.stringify({ text: 'before gap' }),
        creatorAccount: 'peer',
        creatorDomain: 'local',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        threadId,
        seq: 36,
        originSeq: 26,
        contentType: ContentType.PURE_TEXT,
        content: JSON.stringify({ text: 'after gap' }),
        creatorAccount: 'peer',
        creatorDomain: 'local',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await database.db.insert(federationThreadHistoryGap).values({
      threadId,
      namespaceId: 0,
      startSeq: 5,
      endSeq: 25,
      messageSeqOffset: 10,
      recoverable: true,
    });
  });

  function queryMessages(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/query-messages')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ threadId, ...body });
  }

  it('clips the backward endpoint while validating the starting cursor', async () => {
    const bootstrap = await queryMessages({});
    expect(bootstrap.body.code).toBe(30006);
    const { resumeAfter, resumeBefore } = bootstrap.body.data;
    const invalid = await queryMessages({
      before: resumeAfter + 1,
      through: 0,
      take: 50,
    });
    expect(invalid.body.code).toBe(30006);
    const valid = await queryMessages({
      before: resumeBefore,
      through: 0,
      take: 50,
    });
    expect(valid.body.code).toBe(0);
    expect(
      valid.body.data.messages.map((item: { seq: number }) => item.seq),
    ).toEqual([36, 11]);
    expect(valid.body.data.scannedThrough).toBe(resumeAfter + 1);
  });

  it('clips backward history to the cleared boundary instead of rejecting its endpoint', async () => {
    await database.db
      .update(messageThread)
      .set({ clearedSeq: 10 })
      .where(eq(messageThread.id, threadId));
    const response = await queryMessages({ before: 51, through: 0, take: 50 });
    expect(response.body.code).toBe(0);
    expect(response.body.data.scannedThrough).toBe(11);
    expect(
      response.body.data.messages.map((item: { seq: number }) => item.seq),
    ).toEqual([36, 11]);
  });

  it('returns the full locally translated gap when only part intersects the scan', async () => {
    const response = await queryMessages({ after: 10, through: 20, take: 10 });

    expect(response.body.code).toBe(0);
    expect(
      response.body.data.messages.map((item: { seq: number }) => item.seq),
    ).toEqual([11]);
    expect(response.body.data.gaps).toEqual([
      { startSeq: 15, endSeq: 35, recoverable: true },
    ]);
    expect(response.body.data).toMatchObject({
      scannedThrough: 20,
      hasMore: false,
    });
  });

  it('clips a full gap to the participant visibility window', async () => {
    await database.db
      .update(accountThreadState)
      .set({ messageVisibleThroughSeq: 30 })
      .where(eq(accountThreadState.accountId, viewerId));

    const response = await queryMessages({ after: 10, through: 20, take: 10 });

    expect(response.body.code).toBe(0);
    expect(response.body.data.gaps).toEqual([
      { startSeq: 15, endSeq: 30, recoverable: true },
    ]);
  });
});
