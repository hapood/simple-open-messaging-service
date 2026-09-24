import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import { message, messageThread } from '../src/database/schema.js';
import { ContentType } from '../src/database/enums.js';
import { seedAcceptedRelationship, seedSession, seedUser } from './seed.js';
import { createTestApp } from './support/app';
import { truncateTablesForTest } from './support/truncate';

describe('message search pagination', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let token: string;
  let threadId: number;

  beforeAll(async () => {
    ({ app, database } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread" RESTART IDENTITY CASCADE',
    );
    const viewer = await seedUser(app, 'search-viewer');
    const peer = await seedUser(app, 'search-peer');
    token = await seedSession(app, viewer.id, 'app');
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'P2P',
        curSeq: 55,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await seedAcceptedRelationship(database.db, viewer.id, peer.id, threadId);
    await database.db.insert(message).values(
      Array.from({ length: 55 }, (_, index) => ({
        threadId,
        seq: index + 1,
        originSeq: index + 1,
        contentType: ContentType.PURE_TEXT,
        content: JSON.stringify({ text: `pagehit-${index + 1}` }),
        creatorAccount: 'search-peer',
        creatorDomain: 'local',
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );
  });

  function search(lastSeq?: number) {
    return request(app.getHttpServer())
      .post('/api/v1/search-messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ threadId, keyword: 'pagehit-', take: 50, lastSeq });
  }

  it('reports the full visible total independently of cursor and page size', async () => {
    const first = (await search()).body;
    expect(first.code).toBe(0);
    expect(first.totalCount).toBe(55);
    expect(first.hasMore).toBe(true);
    expect(first.data).toHaveLength(50);
    expect(first.data[49].seq).toBe(6);

    const second = (await search(6)).body;
    expect(second.code).toBe(0);
    expect(second.totalCount).toBe(55);
    expect(second.hasMore).toBe(false);
    expect(second.data.map((row: { seq: number }) => row.seq)).toEqual([
      5, 4, 3, 2, 1,
    ]);

    const empty = (await search(1)).body;
    expect(empty.totalCount).toBe(55);
    expect(empty.data).toEqual([]);
    expect(empty.hasMore).toBe(false);
  });

  it('excludes cleared history from both the total and paginated results', async () => {
    await database.db
      .update(messageThread)
      .set({ clearedSeq: 5 })
      .where(eq(messageThread.id, threadId));
    const first = (await search()).body;
    expect(first.totalCount).toBe(50);
    expect(first.hasMore).toBe(false);
    expect(first.data).toHaveLength(50);
    expect(first.data[49].seq).toBe(6);
  });
});
