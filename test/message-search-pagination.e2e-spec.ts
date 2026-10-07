import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localIdentityDomain } from './support/local-domain.js';
import { withMessageDigest } from './support/message-fixture.js';
import request from 'supertest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
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
      withMessageDigest(
        Array.from({ length: 55 }, (_, index) => ({
          threadId,
          seq: index + 1,
          originSeq: index + 1,
          contentType: ContentType.PURE_TEXT,
          content: JSON.stringify({ text: `pagehit-${index + 1}` }),
          creatorAccount: 'search-peer',

          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      ),
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

  it('matches stored media filenames, mention labels and visible quoted-source text', async () => {
    await database.db
      .update(messageThread)
      .set({ curSeq: 60 })
      .where(eq(messageThread.id, threadId));
    await database.db.insert(message).values(
      withMessageDigest([
        {
          threadId,
          seq: 56,
          originSeq: 56,
          contentType: ContentType.PURE_TEXT,
          content: JSON.stringify({ text: 'quote-origin-needle' }),
          creatorAccount: 'search-peer',

          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          threadId,
          seq: 57,
          originSeq: 57,
          contentType: ContentType.PURE_TEXT,
          content: JSON.stringify({
            text: 'reply-body',
            quote: { seq: 56, domain: localIdentityDomain(), namespaceId: 0 },
          }),
          creatorAccount: 'search-peer',

          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          threadId,
          seq: 58,
          originSeq: 58,
          contentType: ContentType.IMAGE,
          content: JSON.stringify({
            url: '/uploads/msg-assets/aa/bb/' + 'a'.repeat(64),
            w: 10,
            h: 10,
            size: 1,
            name: 'image-needle.png',
          }),
          creatorAccount: 'search-peer',

          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          threadId,
          seq: 59,
          originSeq: 59,
          contentType: ContentType.PURE_TEXT,
          content: JSON.stringify({
            text: '[@Mention Needle](somfp://user/search-peer%40local) hello',
          }),
          creatorAccount: 'search-peer',

          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          threadId,
          seq: 60,
          originSeq: 60,
          contentType: ContentType.GALLERY,
          content: JSON.stringify({
            items: [
              {
                kind: 'IMAGE',
                url: '/uploads/msg-assets/aa/bb/' + 'a'.repeat(64),
                size: 1,
                w: 10,
                h: 10,
                name: 'gallery-needle.png',
              },
            ],
          }),
          creatorAccount: 'search-peer',

          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    );
    const find = async (keyword: string) =>
      (
        await request(app.getHttpServer())
          .post('/api/v1/search-messages')
          .set('Authorization', `Bearer ${token}`)
          .send({ threadId, keyword, take: 50 })
      ).body;
    expect(
      (await find('quote-origin-needle')).data.map(
        (row: { seq: number }) => row.seq,
      ),
    ).toEqual([57, 56]);
    expect(
      (await find('reply-body')).data.map((row: { seq: number }) => row.seq),
    ).toEqual([57]);
    expect(
      (await find('image-needle')).data.map((row: { seq: number }) => row.seq),
    ).toEqual([58]);
    expect(
      (await find('gallery-needle')).data.map(
        (row: { seq: number }) => row.seq,
      ),
    ).toEqual([60]);
    expect(
      (await find('Mention Needle')).data.map(
        (row: { seq: number }) => row.seq,
      ),
    ).toEqual([59]);
    await database.db
      .update(messageThread)
      .set({ clearedSeq: 56 })
      .where(eq(messageThread.id, threadId));
    expect((await find('quote-origin-needle')).data).toEqual([]);
    await database.db
      .update(messageThread)
      .set({ clearedSeq: null })
      .where(eq(messageThread.id, threadId));
    await database.db
      .update(message)
      .set({ isDeleted: true })
      .where(and(eq(message.threadId, threadId), eq(message.seq, 56)));
    expect((await find('quote-origin-needle')).data).toEqual([]);
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
