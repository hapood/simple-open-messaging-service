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
  threadMember,
  threadParticipant,
} from '../src/database/schema.js';
import { GroupService } from '../src/group/group.service.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { FederationRelationshipCommandService } from '../src/federation/federation-relationship-command.service.js';
import { seedUserWithSession } from './seed.js';
import {
  waitForAcceptedDomainCommand,
  waitForAcceptedDomainCommands,
  waitForLocalFriendInvite,
} from './domain-command-helpers.js';

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

  async function submitApplication(
    threadId: number,
    memberUserId: number,
    note: string,
  ): Promise<void> {
    const database = app.get(DatabaseService);
    await database.db.transaction(async (tx) => {
      const updates: Array<{ userId: number; feedId: number }> = [];
      await app
        .get(FederationRelationshipCommandService)
        .writeMemberRelationshipIntentInTx(
          tx,
          threadId,
          memberUserId,
          'REQUESTED',
          updates,
          note,
        );
    });
  }

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
      columns: { groupId: true },
    });
    expect(thread?.groupId).toBeTypeOf('number');

    await submitApplication(threadId, applicant.id, 'please');

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
    await waitForAcceptedDomainCommand(database.db, rejected.body);

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
          eq(threadParticipant.accountId, owner.id),
        ),
      );
    expect(
      await app.get(GroupService).garbageCollectJoinRequestProjections(),
    ).toBe(0);
    expect(
      await database.db.query.groupRequestProjection.findMany({
        where: eq(groupRequestProjection.threadId, threadId),
      }),
    ).toHaveLength(1);
    await database.db
      .update(threadMember)
      .set({ left: true, updatedAt: new Date() })
      .where(
        and(
          eq(threadMember.threadId, threadId),
          eq(threadMember.userId, owner.id),
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
      .send({ account: member.account });
    expect(friendRequest.body.code).toBe(BusinessCode.OK);
    const friendInviteId = await waitForLocalFriendInvite(
      app.get(DatabaseService).db,
      friendRequest.body.data.commandId,
      owner.id,
      member.id,
    );
    const accepted = await request(app.getHttpServer())
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ inviteId: friendInviteId });
    expect(accepted.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDomainCommand(
      app.get(DatabaseService).db,
      accepted.body,
    );

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
    await waitForAcceptedDomainCommands(
      app.get(DatabaseService).db,
      invited.body,
    );

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
    await waitForAcceptedDomainCommand(
      app.get(DatabaseService).db,
      revoked.body,
    );
    const history = await request(app.getHttpServer())
      .post('/api/v1/group/invitations')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId });
    expect(history.body.data.data[0].status).toBe('REVOKED');
  });

  it('updates an existing application on manager ACK without creating an invitation projection', async () => {
    const owner = await seedUserWithSession(app, 'application-ack-owner');
    const applicant = await seedUserWithSession(app, 'application-ack-member');
    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Application ACK projection' });
    const threadId = created.body.data.threadId as number;
    const database = app.get(DatabaseService);
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
      columns: { groupId: true },
    });
    expect(thread?.groupId).toBeTypeOf('number');
    await submitApplication(threadId, applicant.id, 'accept me');
    const pending = await request(app.getHttpServer())
      .post('/api/v1/group/join-requests')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId });
    const requestId = pending.body.data.data[0].id as string;

    const accepted = await request(app.getHttpServer())
      .post('/api/v1/group/join-request/accept')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, requestId });
    expect(accepted.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDomainCommand(database.db, accepted.body);

    const projections = await database.db.query.groupRequestProjection.findMany(
      {
        where: and(
          eq(groupRequestProjection.managerUserId, owner.id),
          eq(groupRequestProjection.threadId, threadId),
          eq(groupRequestProjection.memberUserId, applicant.id),
        ),
      },
    );
    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      direction: 'APPLICATION',
      status: 'ACCEPTED',
      requestId: BigInt(requestId),
    });
  });

  it('updates an existing invitation on member ACK without creating an application projection', async () => {
    const owner = await seedUserWithSession(app, 'invitation-ack-owner');
    const member = await seedUserWithSession(app, 'invitation-ack-member');
    const friendRequest = await request(app.getHttpServer())
      .post('/api/v1/invite/friend')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ account: member.account });
    const friendInviteId = await waitForLocalFriendInvite(
      app.get(DatabaseService).db,
      friendRequest.body.data.commandId,
      owner.id,
      member.id,
    );
    const friendAccepted = await request(app.getHttpServer())
      .post('/api/v1/invite/accept')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ inviteId: friendInviteId });
    await waitForAcceptedDomainCommand(
      app.get(DatabaseService).db,
      friendAccepted.body,
    );
    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Invitation ACK projection' });
    const threadId = created.body.data.threadId as number;
    const invited = await request(app.getHttpServer())
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, userIds: [member.id] });
    expect(invited.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDomainCommands(
      app.get(DatabaseService).db,
      invited.body,
    );

    const database = app.get(DatabaseService);
    expect(
      await database.db.query.threadMember.findFirst({
        where: and(
          eq(threadMember.threadId, threadId),
          eq(threadMember.userId, member.id),
        ),
      }),
    ).toBeUndefined();
    const candidates = await request(app.getHttpServer())
      .post('/api/v1/group/invite-candidates')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, search: member.account });
    expect(candidates.body.data.data).toEqual([
      expect.objectContaining({ userId: member.id, state: 'INVITED' }),
    ]);

    const accepted = await request(app.getHttpServer())
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ groupId: threadId });
    expect(accepted.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDomainCommand(database.db, accepted.body);

    const acceptedCandidates = await request(app.getHttpServer())
      .post('/api/v1/group/invite-candidates')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, search: member.account });
    expect(acceptedCandidates.body.data.data).toEqual([
      expect.objectContaining({ userId: member.id, state: 'MEMBER' }),
    ]);

    const projections = await database.db.query.groupRequestProjection.findMany(
      {
        where: and(
          eq(groupRequestProjection.managerUserId, owner.id),
          eq(groupRequestProjection.threadId, threadId),
          eq(groupRequestProjection.memberUserId, member.id),
        ),
      },
    );
    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      direction: 'INVITATION',
      status: 'ACCEPTED',
    });

    const left = await request(app.getHttpServer())
      .post('/api/v1/group/leave')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ groupId: threadId });
    expect(left.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDomainCommand(database.db, left.body);
    expect(
      await database.db.query.threadMember.findFirst({
        where: and(
          eq(threadMember.threadId, threadId),
          eq(threadMember.userId, member.id),
        ),
      }),
    ).toMatchObject({ left: true });
  });

  it('does not manufacture a group request projection from a terminal fact', async () => {
    const owner = await seedUserWithSession(app, 'terminal-effect-owner');
    const member = await seedUserWithSession(app, 'terminal-effect-member');
    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Terminal projection effect' });
    const threadId = created.body.data.threadId as number;
    const database = app.get(DatabaseService);
    const feedId = await database.db.transaction((tx) =>
      app.get(ClientStateFeedService).writeGroupRequestInTx(tx, {
        managerUserId: owner.id,
        threadId,
        memberUserId: member.id,
        direction: 'APPLICATION',
        requestId: 999n,
        status: 'ACCEPTED',
        note: '',
        requestedAt: null,
        expiresAt: null,
      }),
    );
    expect(feedId).toBeNull();
    expect(
      await database.db.query.groupRequestProjection.findMany({
        where: and(
          eq(groupRequestProjection.managerUserId, owner.id),
          eq(groupRequestProjection.threadId, threadId),
          eq(groupRequestProjection.memberUserId, member.id),
        ),
      }),
    ).toEqual([]);
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
      columns: { groupId: true },
    });
    expect(thread?.groupId).toBeTypeOf('number');
    await database.db.transaction(async (tx) => {
      const updates: Array<{ userId: number; feedId: number }> = [];
      const federation = app.get(FederationRelationshipCommandService);
      await federation.writeGroupRelationshipIntentInTx(
        tx,
        threadId,
        admin.id,
        '',
        'REQUESTED',
        updates,
      );
      await federation.writeMemberRelationshipIntentInTx(
        tx,
        threadId,
        admin.id,
        'ACCEPTED',
        updates,
      );
    });
    await submitApplication(threadId, applicant.id, 'admin should see this');

    const promoted = await request(app.getHttpServer())
      .post('/api/v1/group/set-role')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        groupId: threadId,
        account: admin.account,
        domain: 'local',
        role: 'ADMIN',
      });
    expect(promoted.body.code, JSON.stringify(promoted.body)).toBe(
      BusinessCode.OK,
    );
    await waitForAcceptedDomainCommand(database.db, promoted.body);
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
      .send({
        groupId: threadId,
        account: admin.account,
        domain: 'local',
        role: 'MEMBER',
      });
    expect(demoted.body.code, JSON.stringify(demoted.body)).toBe(
      BusinessCode.OK,
    );
    await waitForAcceptedDomainCommand(database.db, demoted.body);
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
      .send({
        groupId: threadId,
        account: admin.account,
        domain: 'local',
        role: 'ADMIN',
      });
    expect(promotedAgain.body.code).toBe(BusinessCode.OK);
    await waitForAcceptedDomainCommand(database.db, promotedAgain.body);
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
    await waitForAcceptedDomainCommand(database.db, left.body);
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
