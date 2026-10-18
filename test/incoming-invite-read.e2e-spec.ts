import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { account, clientStateFeed } from '../src/database/schema.js';
import { seedUserWithSession } from './seed.js';
import { createTestApp } from './support/app';
import { truncateTablesForTest } from './support/truncate';

describe('incoming invitation read watermark', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let stateFeed: ClientStateFeedService;

  beforeAll(async () => {
    ({ app, database } = await createTestApp());
    stateFeed = app.get(ClientStateFeedService);
  });

  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread" RESTART IDENTITY CASCADE',
    );
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
        account: '',
        namespaceId: 0,
        eventType: 'INCOMING_INVITE_HEAD',
        subjectAccount: '',
        subjectNamespaceId: 0,
        body: {
          readThroughFeedId: 0,
        },
      }),
    );
    const auth = { Authorization: `Bearer ${seeded.token}` };

    const advanced = await request(app.getHttpServer())
      .post('/api/v1/relationship/requests/read')
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
      namespaceId: 0,
      subjectAccount: '',
      feedId: 2,
      body: { readThroughFeedId: 1 },
    });

    const replay = await request(app.getHttpServer())
      .post('/api/v1/relationship/requests/read')
      .set(auth)
      .send({ readThroughFeedId: 0 })
      .expect(200);
    expect(replay.body.data).toEqual({ readThroughFeedId: 1 });
    const owner = await database.db.query.account.findFirst({
      where: eq(account.id, seeded.id),
      columns: { clientStateFeedEndId: true },
    });
    expect(owner?.clientStateFeedEndId).toBe(2);

    await request(app.getHttpServer())
      .post('/api/v1/relationship/requests/read')
      .set(auth)
      .send({ readThroughFeedId: 3 })
      .expect(400);
  });
});
