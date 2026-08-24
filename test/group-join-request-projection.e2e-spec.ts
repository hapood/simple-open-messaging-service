import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  clientStateFeed,
  groupJoinRequestProjection,
  messageThread,
  relationshipIntent,
  relationshipPair,
  threadParticipant,
} from '../src/database/schema.js';
import { GroupService } from '../src/group/group.service.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { seedUserWithSession } from './seed.js';

describe('group join request projection', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = fixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
  });

  afterAll(async () => app.close());

  it('retains a rejection and physically collects the projection after seven days', async () => {
    const owner = await seedUserWithSession(app, 'join-projection-owner');
    const applicant = await seedUserWithSession(
      app,
      'join-projection-applicant',
    );
    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Projected requests' });
    expect(created.body.code).toBe(BusinessCode.OK);
    const threadId = created.body.data.threadId as number;
    const database = app.get(DatabaseService);
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
      columns: { groupUserId: true },
    });

    const sent = await request(app.getHttpServer())
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${applicant.token}`)
      .send({ toUserId: thread!.groupUserId, note: 'please' });
    expect(sent.body.code).toBe(BusinessCode.OK);

    const pending = await request(app.getHttpServer())
      .post('/api/v1/group/join-requests')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId });
    expect(pending.body.data.data).toHaveLength(1);
    expect(pending.body.data.data[0]).toMatchObject({
      status: 'REQUESTED',
      note: 'please',
    });
    expect(Number.isInteger(pending.body.data.data[0].feedId)).toBe(true);
    expect(
      await database.db.query.clientStateFeed.findFirst({
        where: and(
          eq(clientStateFeed.userId, owner.id),
          eq(clientStateFeed.account, applicant.account),
          eq(clientStateFeed.eventType, 'PROFILE'),
        ),
      }),
    ).toBeDefined();
    const read = await request(app.getHttpServer())
      .post('/api/v1/group/join-requests/read')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        groupId: threadId,
        readFeedId: pending.body.data.data[0].feedId,
      });
    expect(read.body.code).toBe(BusinessCode.OK);
    const readHead = await database.db.query.clientStateFeed.findFirst({
      where: and(
        eq(clientStateFeed.userId, owner.id),
        eq(clientStateFeed.eventType, 'GROUP_JOIN_REQUEST_HEAD'),
      ),
    });
    expect(readHead?.body).toMatchObject({
      latestFeedId: pending.body.data.data[0].feedId,
      readFeedId: pending.body.data.data[0].feedId,
    });

    const rejected = await request(app.getHttpServer())
      .post('/api/v1/group/join-request/reject')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, requestId: pending.body.data.data[0].id });
    expect(rejected.body.code).toBe(BusinessCode.OK);

    const history = await request(app.getHttpServer())
      .post('/api/v1/group/join-requests')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId });
    expect(history.body.data.data).toHaveLength(1);
    expect(history.body.data.data[0].status).toBe('REVOKED');
    expect(history.body.data.data[0].feedId).toBeGreaterThan(
      pending.body.data.data[0].feedId,
    );

    const requestedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await database.db
      .update(groupJoinRequestProjection)
      .set({
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
      })
      .where(eq(groupJoinRequestProjection.threadId, threadId));
    expect(
      await app.get(GroupService).garbageCollectJoinRequestProjections(),
    ).toBe(1);
    const afterGc = await database.db.query.groupJoinRequestProjection.findMany(
      {
        where: eq(groupJoinRequestProjection.threadId, threadId),
      },
    );
    expect(afterGc).toEqual([]);
    expect(
      await database.db.query.clientStateFeed.findFirst({
        where: and(
          eq(clientStateFeed.userId, owner.id),
          eq(clientStateFeed.account, applicant.account),
          eq(clientStateFeed.eventType, 'PROFILE'),
        ),
      }),
    ).toBeUndefined();

    const now = new Date();
    await database.db.insert(groupJoinRequestProjection).values({
      managerUserId: owner.id,
      threadId,
      applicantUserId: applicant.id,
      feedId: history.body.data.data[0].feedId + 1,
      requestId: BigInt(history.body.data.data[0].id),
      status: 'REVOKED',
      note: 'please',
      requestedAt: now,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    });
    await database.db.transaction((tx) =>
      app
        .get(ClientStateFeedService)
        .recordProfileStateInTx(tx, applicant.id, [owner.id]),
    );
    expect(
      await database.db.query.clientStateFeed.findFirst({
        where: and(
          eq(clientStateFeed.userId, owner.id),
          eq(clientStateFeed.account, applicant.account),
          eq(clientStateFeed.eventType, 'PROFILE'),
        ),
      }),
    ).toBeDefined();
    await database.db
      .delete(threadParticipant)
      .where(
        and(
          eq(threadParticipant.threadId, threadId),
          eq(threadParticipant.userId, owner.id),
        ),
      );
    expect(
      await app.get(GroupService).garbageCollectJoinRequestProjections(),
    ).toBe(1);
    expect(
      await database.db.query.groupJoinRequestProjection.findMany({
        where: eq(groupJoinRequestProjection.threadId, threadId),
      }),
    ).toEqual([]);
    expect(
      await database.db.query.clientStateFeed.findFirst({
        where: and(
          eq(clientStateFeed.userId, owner.id),
          eq(clientStateFeed.account, applicant.account),
          eq(clientStateFeed.eventType, 'PROFILE'),
        ),
      }),
    ).toBeUndefined();
  });

  it('backfills a promoted administrator and removes its projection/profile on demotion', async () => {
    const owner = await seedUserWithSession(app, 'join-role-owner');
    const admin = await seedUserWithSession(app, 'join-role-admin');
    const applicant = await seedUserWithSession(app, 'join-role-applicant');
    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Role projection' });
    const threadId = created.body.data.threadId as number;
    const database = app.get(DatabaseService);
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
      columns: { groupUserId: true },
    });
    const groupUserId = thread!.groupUserId!;
    const now = new Date();
    await database.db.transaction(async (tx) => {
      await tx.insert(relationshipPair).values({
        userLowId: Math.min(groupUserId, admin.id),
        userHighId: Math.max(groupUserId, admin.id),
        threadId,
        active: true,
        updatedAt: now,
      });
      await tx.insert(relationshipIntent).values([
        {
          authorUserId: groupUserId,
          subjectUserId: admin.id,
          status: 'ACCEPTED',
          requestedAt: now,
          updatedAt: now,
        },
        {
          authorUserId: admin.id,
          subjectUserId: groupUserId,
          status: 'ACCEPTED',
          requestedAt: now,
          updatedAt: now,
        },
      ]);
      await tx.insert(threadParticipant).values({
        userId: admin.id,
        threadId,
        role: 'MEMBER',
        relationshipRev: 1,
        updatedAt: now,
      });
    });
    const sent = await request(app.getHttpServer())
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${applicant.token}`)
      .send({ toUserId: groupUserId, note: 'admin should see this' });
    expect(sent.body.code).toBe(BusinessCode.OK);

    const promoted = await request(app.getHttpServer())
      .post('/api/v1/group/set-role')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, userId: admin.id, role: 'ADMIN' });
    expect(promoted.body.code, JSON.stringify(promoted.body)).toBe(
      BusinessCode.OK,
    );
    expect(
      await database.db.query.groupJoinRequestProjection.findMany({
        where: and(
          eq(groupJoinRequestProjection.managerUserId, admin.id),
          eq(groupJoinRequestProjection.threadId, threadId),
        ),
      }),
    ).toHaveLength(1);
    expect(
      await database.db.query.clientStateFeed.findFirst({
        where: and(
          eq(clientStateFeed.userId, admin.id),
          eq(clientStateFeed.account, applicant.account),
          eq(clientStateFeed.eventType, 'PROFILE'),
        ),
      }),
    ).toBeDefined();

    const demoted = await request(app.getHttpServer())
      .post('/api/v1/group/set-role')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, userId: admin.id, role: 'MEMBER' });
    expect(demoted.body.code, JSON.stringify(demoted.body)).toBe(
      BusinessCode.OK,
    );
    expect(
      await database.db.query.groupJoinRequestProjection.findMany({
        where: eq(groupJoinRequestProjection.managerUserId, admin.id),
      }),
    ).toEqual([]);
    expect(
      await database.db.query.clientStateFeed.findFirst({
        where: and(
          eq(clientStateFeed.userId, admin.id),
          eq(clientStateFeed.account, applicant.account),
          eq(clientStateFeed.eventType, 'PROFILE'),
        ),
      }),
    ).toBeUndefined();
  });
});
