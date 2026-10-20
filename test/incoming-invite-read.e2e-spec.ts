import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { desc, eq } from 'drizzle-orm';
import request from 'supertest';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { account, clientStateFeed } from '../src/database/schema.js';
import { lockBusinessAccountsInTx } from '../src/common/locks/account-business-lock.js';
import { seedUserWithSession } from './seed.js';
import { createTestApp } from './support/app';
import { truncateTablesForTest } from './support/truncate';

describe('incoming request read watermark', () => {
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
    await app?.close();
  });

  it('advances request IDs monotonically without treating them as feed positions', async () => {
    const seeded = await seedUserWithSession(app, 'invite-reader', {
      name: 'Invite reader',
    });
    const endId = '9007199254740993';
    await database.db.transaction(async (tx) => {
      await lockBusinessAccountsInTx(tx, [
        { account: 'invite-reader', profileNamespaceId: 0 },
      ]);
      await tx.update(account).set({ requestEndId: BigInt(endId) })
        .where(eq(account.id, seeded.id));
      expect(await stateFeed.publishRequestHeadInTx(tx, seeded.id)).toBe(1);
    });
    const auth = { Authorization: `Bearer ${seeded.token}` };

    const advanced = await request(app.getHttpServer())
      .post('/api/v1/relationship/requests/read')
      .set(auth)
      .send({ requestReadId: endId })
      .expect(200);
    expect(advanced.body).toMatchObject({
      code: 0,
      data: { requestEndId: endId, requestReadId: endId },
    });

    const versions = await database.db.query.clientStateFeed.findMany({
      where: eq(clientStateFeed.userId, seeded.id),
      orderBy: [desc(clientStateFeed.feedId)],
    });
    expect(versions.map(({ feedId, body }) => ({ feedId, body }))).toEqual([
      { feedId: 2, body: { requestEndId: endId, requestReadId: endId } },
      { feedId: 1, body: { requestEndId: endId, requestReadId: '0' } },
    ]);

    const replay = await request(app.getHttpServer())
      .post('/api/v1/relationship/requests/read')
      .set(auth)
      .send({ requestReadId: '0' })
      .expect(200);
    expect(replay.body).toMatchObject({
      code: 0,
      data: { requestEndId: endId, requestReadId: endId },
    });
    const owner = await database.db.query.account.findFirst({
      where: eq(account.id, seeded.id),
      columns: { clientStateFeedEndId: true, requestEndId: true, requestReadId: true },
    });
    expect(owner).toEqual({
      clientStateFeedEndId: 2, requestEndId: BigInt(endId), requestReadId: BigInt(endId),
    });

    // Preserve the existing future-watermark rejection contract. This is an
    // ahead request ID, not an ahead state-feed cursor.
    await request(app.getHttpServer())
      .post('/api/v1/relationship/requests/read')
      .set(auth)
      .send({ requestReadId: (BigInt(endId) + 1n).toString() })
      .expect(400);
    expect(await database.db.query.account.findFirst({
      where: eq(account.id, seeded.id),
      columns: { clientStateFeedEndId: true, requestEndId: true, requestReadId: true },
    })).toEqual(owner);
    expect(await database.db.query.clientStateFeed.findMany({
      where: eq(clientStateFeed.userId, seeded.id),
      orderBy: [desc(clientStateFeed.feedId)],
    })).toEqual(versions);
  });
});
