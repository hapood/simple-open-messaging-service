import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/database/database.service';
import {
  account as accountTable,
  message,
  messageThread,
  threadParticipant,
} from '../src/database/schema';
import { ContentType } from '../src/database/enums.js';
import { seedAcceptedRelationship, seedSession, seedUser } from './seed';

describe('POST /thread/mark-read authoritative state', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let token: string;
  let viewerId: number;
  let peerId: number;
  let threadId: number;
  let viewerParticipantId: number;

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

  afterAll(async () => app.close());

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
    const viewer = await seedUser(app, 'reader', { name: 'Reader' });
    const peer = await seedUser(app, 'peer', { name: 'Peer' });
    viewerId = viewer.id;
    peerId = peer.id;
    token = await seedSession(app, viewerId, 'app');
    const now = new Date();
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'P2P',
        curSeq: 1005,
        lastMessageSeq: 1005,
        lastMessageAt: now,
        updatedAt: now,
      })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await seedAcceptedRelationship(database.db, viewerId, peerId, threadId);
    const viewerParticipant =
      await database.db.query.threadParticipant.findFirst({
      where: and(
        eq(threadParticipant.threadId, threadId),
        eq(threadParticipant.accountId, viewerId),
      ),
      columns: { id: true },
    });
    if (!viewerParticipant)
      throw new Error('viewer thread participant is missing');
    viewerParticipantId = viewerParticipant.id;
    await database.db.insert(message).values(
      Array.from({ length: 1005 }, (_, index) => {
        const seq = index + 1;
        return {
          threadId,
          seq,
          contentType: ContentType.PURE_TEXT,
          content: JSON.stringify({
            text:
              seq === 2
                ? '[@所有人](somfp://audience/all)'
                : seq === 3
                  ? '[@Reader](somfp://user/reader)'
                  : `message-${seq}`,
          }),
          // The viewer's own seq=1 message must never contribute to unreadCount.
          creatorAccount: seq === 1 ? 'reader' : 'peer',
          creatorDomain: 'local',
          updatedAt: now,
        };
      }),
    );
  });

  function commit(localReadHwm: number) {
    return request(app.getHttpServer())
      .post('/api/v1/thread/mark-read')
      .set('Authorization', `Bearer ${token}`)
      .send({ threadId, localReadHwm });
  }

  function readDelta(fromRevision: number, toRevision: number) {
    return request(app.getHttpServer())
      .post('/api/v1/thread/read-delta')
      .set('Authorization', `Bearer ${token}`)
      .send({ fromRevision, toRevision });
  }

  it('returns ACK-only, advances readRevision, and exposes authoritative state through read delta', async () => {
    const capped = await commit(1);
    expect(capped.body.code).toBe(0);
    expect(capped.body.data).toBeUndefined();
    const firstDelta = await readDelta(0, 1);
    expect(firstDelta.body.data.readRevision).toBe(1);
    expect(firstDelta.body.data.items[0]).toMatchObject({
      threadId,
      lastReadSeq: 1,
      readRevision: 1,
      unreadCount: 1000,
    });
    expect(new Set(firstDelta.body.data.items[0].mentionUnread)).toEqual(
      new Set(['all', 'me']),
    );

    // Simulate a newer server cursor from another session; a stale local report cannot move it backwards.
    await database.db
      .update(threadParticipant)
      .set({ lastReadSeq: 3 })
      .where(eq(threadParticipant.id, viewerParticipantId));
    const monotonic = await commit(1);
    expect(monotonic.body.data).toBeUndefined();
    const secondDelta = await readDelta(1, 2);
    expect(secondDelta.body.data.items[0]).toMatchObject({
      lastReadSeq: 3,
      readRevision: 2,
      unreadCount: 1000,
      mentionUnread: [],
    });

    // Below the cap the response is exact: seq 1001..1005 are five peer-authored unread messages.
    const exact = await commit(1000);
    expect(exact.body.data).toBeUndefined();
    const thirdDelta = await readDelta(2, 3);
    expect(thirdDelta.body.data.items[0]).toMatchObject({
      lastReadSeq: 1000,
      readRevision: 3,
      unreadCount: 5,
    });

    const [viewer, participant] = await Promise.all([
      database.db.query.account.findFirst({
        where: eq(accountTable.id, viewerId),
      }),
      database.db.query.threadParticipant.findFirst({
        where: eq(threadParticipant.id, viewerParticipantId),
      }),
    ]);
    expect(viewer?.readRevision).toBe(3);
    expect(participant?.readRevision).toBe(3);
  });
});
