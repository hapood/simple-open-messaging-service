import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { account, clientStateFeed } from '../src/database/schema.js';
import { seedUserWithSession } from './seed.js';

describe('incoming invitation read watermark', () => {
  let app: INestApplication;
  let module: TestingModule;
  let database: DatabaseService;
  let stateFeed: ClientStateFeedService;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const adapter = new FastifyAdapter();
    app = module.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
    stateFeed = app.get(ClientStateFeedService);
  });

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await app.close();
  });

  it('advances monotonically, emits a compacted head, and rejects a future cursor', async () => {
    const seeded = await seedUserWithSession(app, 'invite-reader', {
      name: 'Invite reader',
    });
    await database.db.transaction((tx) =>
      stateFeed.writeInTx(tx, {
        userId: seeded.id,
        account: 'inviter',
        domain: 'local',
        eventType: 'PROFILE',
        subjectAccount: '',
        subjectDomain: '',
        body: {
          profileRev: 1,
          displayName: 'Inviter',
          bio: '',
          avatar: null,
        },
      }),
    );
    const auth = { Authorization: `Bearer ${seeded.token}` };

    const advanced = await request(app.getHttpServer())
      .post('/api/v1/invite/incoming/read')
      .set(auth)
      .send({ readThroughFeedId: 1 })
      .expect(200);
    expect(advanced.body).toMatchObject({
      code: 0,
      data: { readThroughFeedId: 1 },
    });

    const head = await database.db.query.clientStateFeed.findFirst({
      where: and(
        eq(clientStateFeed.userId, seeded.id),
        eq(clientStateFeed.eventType, 'INCOMING_INVITE_HEAD'),
      ),
    });
    expect(head).toMatchObject({
      account: '',
      domain: 'local',
      subjectAccount: '',
      subjectDomain: 'local',
      feedId: 2,
      body: { readThroughFeedId: 1 },
    });

    const replay = await request(app.getHttpServer())
      .post('/api/v1/invite/incoming/read')
      .set(auth)
      .send({ readThroughFeedId: 0 })
      .expect(200);
    expect(replay.body.data).toEqual({ readThroughFeedId: 1 });
    const owner = await database.db.query.account.findFirst({
      where: eq(account.id, seeded.id),
      columns: { stateFeedAllocatedThrough: true },
    });
    expect(owner?.stateFeedAllocatedThrough).toBe(2);

    await request(app.getHttpServer())
      .post('/api/v1/invite/incoming/read')
      .set(auth)
      .send({ readThroughFeedId: 3 })
      .expect(400);
  });
});
