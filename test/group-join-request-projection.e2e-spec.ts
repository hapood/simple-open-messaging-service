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
  groupRequestProjection,
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
      .update(groupRequestProjection)
      .set({
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
      })
      .where(eq(groupRequestProjection.threadId, threadId));
    expect(
      await app.get(GroupService).garbageCollectJoinRequestProjections(),
    ).toBe(1);
    const afterGc = await database.db.query.groupRequestProjection.findMany({
      where: eq(groupRequestProjection.threadId, threadId),
    });
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
    await database.db.insert(groupRequestProjection).values({
      managerUserId: owner.id,
      threadId,
      memberUserId: applicant.id,
      direction: 'APPLICATION',
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
      await database.db.query.groupRequestProjection.findMany({
        where: eq(groupRequestProjection.threadId, threadId),
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

  it('projects group invitations through the symmetric manager API', async () => {
    const owner = await seedUserWithSession(app, 'invitation-projection-owner');
    const member = await seedUserWithSession(
      app,
      'invitation-projection-member',
    );
    const friendRequest = await request(app.getHttpServer())
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ toUserId: member.id });
    expect(friendRequest.body.code).toBe(BusinessCode.OK);
    const accepted = await request(app.getHttpServer())
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ inviteId: friendRequest.body.data.inviteId });
    expect(accepted.body.code).toBe(BusinessCode.OK);

    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Invitation projection' });
    const threadId = created.body.data.threadId as number;
    const invited = await request(app.getHttpServer())
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, userIds: [member.id] });
    expect(invited.body.code).toBe(BusinessCode.OK);
    expect(invited.body.data.invited).toEqual([member.id]);

    const pending = await request(app.getHttpServer())
      .post('/api/v1/group/invitations')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId });
    expect(pending.body.data.data).toHaveLength(1);
    expect(pending.body.data.data[0]).toMatchObject({
      userId: member.id,
      status: 'REQUESTED',
    });

    const revoked = await request(app.getHttpServer())
      .post('/api/v1/group/invitation/revoke')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, requestId: pending.body.data.data[0].id });
    expect(revoked.body.code).toBe(BusinessCode.OK);
    const history = await request(app.getHttpServer())
      .post('/api/v1/group/invitations')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId });
    expect(history.body.data.data[0].status).toBe('REVOKED');
  });

  it('immediately collects manager projections on demotion and leave', async () => {
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
      await database.db.query.groupRequestProjection.findMany({
        where: and(
          eq(groupRequestProjection.managerUserId, admin.id),
          eq(groupRequestProjection.threadId, threadId),
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
      await database.db.query.groupRequestProjection.findMany({
        where: eq(groupRequestProjection.managerUserId, admin.id),
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

    const promotedAgain = await request(app.getHttpServer())
      .post('/api/v1/group/set-role')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, userId: admin.id, role: 'ADMIN' });
    expect(promotedAgain.body.code).toBe(BusinessCode.OK);
    expect(
      await database.db.query.groupRequestProjection.findMany({
        where: and(
          eq(groupRequestProjection.managerUserId, admin.id),
          eq(groupRequestProjection.threadId, threadId),
        ),
      }),
    ).toHaveLength(1);

    const left = await request(app.getHttpServer())
      .post('/api/v1/group/leave')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ groupId: threadId, deleteData: false });
    expect(left.body.code, JSON.stringify(left.body)).toBe(BusinessCode.OK);
    expect(
      await database.db.query.groupRequestProjection.findMany({
        where: and(
          eq(groupRequestProjection.managerUserId, admin.id),
          eq(groupRequestProjection.threadId, threadId),
        ),
      }),
    ).toEqual([]);
  });
});
