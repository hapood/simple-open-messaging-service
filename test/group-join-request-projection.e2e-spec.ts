import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { localIdentityDomain } from './support/local-domain.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  groupRequestProjection,
  messageThread,
  accountThreadState,
  durableTask,
} from '../src/database/schema.js';
import { DurableTaskType } from '../src/durable-task/durable-task.constants.js';
import { GroupService } from '../src/group/group.service.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { GroupRelationshipMutationService } from '../src/group/membership-intent/shared/group-relationship-mutation.service.js';
import { admitGroupMembershipProjectionFanoutInTx } from '../src/group/membership-intent/shared/group-membership-projection-fanout.js';
import { lockBusinessAccountsInTx } from '../src/common/locks/account-business-lock.js';
import { readCurrentGroupMemberInTx } from '../src/group/meta/current-group-roster.js';
import { seedUserWithSession } from './seed.js';
import { waitForLocalRelationshipRequest } from './durable-task-helpers.js';
import { createTestApp } from './support/app';

describe('group join request projection', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => app.close());

  async function submitApplication(
    threadId: number,
    memberUserId: number,
    note: string,
  ): Promise<void> {
    const database = app.get(DatabaseService);
    await database.db.transaction(async (tx) => {
      // Flow-entry group advisory: the mutation writers hold row locks only.
      const thread = await database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
        columns: { groupAccount: true, authorityNamespaceId: true },
      });
      if (!thread?.groupAccount)
        throw new Error('Group thread fixture not found');
      await lockBusinessAccountsInTx(tx, [
        {
          account: thread.groupAccount,
          profileNamespaceId: thread.authorityNamespaceId,
        },
      ]);
      const updates: Array<{ userId: number; feedId: number }> = [];
      await app
        .get(GroupRelationshipMutationService)
        .writeMemberRelationshipIntentInTx(
          tx,
          threadId,
          memberUserId,
          'REQUESTED',
          updates,
          note,
        );
      await admitGroupMembershipProjectionFanoutInTx(tx, {
        threadId,
        groupAccount: thread.groupAccount,
      });
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
      columns: { id: true, groupAccount: true },
    });
    expect(thread?.id).toBeTypeOf('number');

    await submitApplication(threadId, applicant.id, 'please');

    const applicantPage = await request(app.getHttpServer())
      .post('/api/v1/group/join-requests')
      .set('Authorization', `Bearer ${applicant.token}`)
      .send({ groupId: threadId });
    expect(applicantPage.body.code).toBe(BusinessCode.THREAD_NOT_FOUND);

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
    // The projection fan-out advances the manager's request watermark before
    // the read endpoint builds its cosmetic head.
    const joinRequestFeedId = pending.body.data.data[0].feedId as number;
    await vi.waitFor(
      async () => {
        const managerState =
          await database.db.query.accountThreadState.findFirst({
            where: and(
              eq(accountThreadState.accountId, owner.id),
              eq(accountThreadState.threadId, threadId),
            ),
          });
        expect(managerState?.joinRequestEndFeedId).toBe(joinRequestFeedId);
      },
      { timeout: 10_000 },
    );
    const read = await request(app.getHttpServer())
      .post('/api/v1/group/join-requests/read')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        groupId: threadId,
        joinRequestReadFeedId: joinRequestFeedId,
      });
    expect(read.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(async () => {
      const readHead = await database.db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.accountId, owner.id),
          eq(accountThreadState.threadId, threadId),
        ),
      });
      expect(readHead).toMatchObject({
        joinRequestEndFeedId: joinRequestFeedId,
        joinRequestReadFeedId: joinRequestFeedId,
      });
    });

    const rejected = await request(app.getHttpServer())
      .post('/api/v1/group/join-request/reject')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        groupId: threadId,
        account: applicant.account,
        namespaceId: 0,
      });
    expect(rejected.body.code).toBe(BusinessCode.OK);

    const history = await request(app.getHttpServer())
      .post('/api/v1/group/join-requests')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId });
    expect(history.body.data.data).toHaveLength(1);
    expect(history.body.data.data[0].status).toBe('REJECTED');
    expect(history.body.data.data[0].feedId).toBe(
      pending.body.data.data[0].feedId,
    );

    // Expiry is the only collection trigger: an unexpired row survives every
    // sweep even when its manager deleted their participation state.
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
    ).toBeGreaterThanOrEqual(1);
    const afterGc = await database.db.query.groupRequestProjection.findMany({
      where: eq(groupRequestProjection.threadId, threadId),
    });
    expect(afterGc).toEqual([]);

    const now = new Date();
    await database.db.insert(groupRequestProjection).values({
      threadId,
      memberAccount: applicant.account,
      profileNamespaceId: 0,
      memberProfileRev: 1,
      direction: 'APPLICATION',
      feedId: history.body.data.data[0].feedId + 1,
      status: 'REJECTED',
      note: 'please',
      requestedAt: now,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    });
    await database.db
      .delete(accountThreadState)
      .where(
        and(
          eq(accountThreadState.threadId, threadId),
          eq(accountThreadState.accountId, owner.id),
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
  });

  it('projects group invitations through the symmetric manager API', async () => {
    const owner = await seedUserWithSession(app, 'invitation-projection-owner');
    const member = await seedUserWithSession(
      app,
      'invitation-projection-member',
    );
    const snapshot = { displayName: 'Member at invitation time', avatar: null };
    const friendRequest = await request(app.getHttpServer())
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        account: member.account,
        namespaceId: 0,
        snapshot: { displayName: 'Member', avatar: null },
      });
    expect(friendRequest.body.code).toBe(BusinessCode.OK);
    await waitForLocalRelationshipRequest(
      app.get(DatabaseService).db,
      friendRequest.body,
      owner.id,
      member.id,
    );
    const accepted = await request(app.getHttpServer())
      .post('/api/v1/relationship/accept')
      .set('Authorization', `Bearer ${member.token}`)
      .send({
        account: owner.account,
        namespaceId: 0,
      });
    expect(accepted.body.code).toBe(BusinessCode.OK);
    expect(accepted.body.data).toMatchObject({ status: 'OK' });

    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Invitation projection' });
    expect(created.body.code, JSON.stringify(created.body)).toBe(
      BusinessCode.OK,
    );
    const threadId = created.body.data.threadId as number;
    const invited = await request(app.getHttpServer())
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        groupId: threadId,
        users: [{ account: member.account, namespaceId: 0, snapshot }],
      });
    expect(invited.body.code).toBe(BusinessCode.OK);
    expect(invited.body.data.invited).toEqual([
      {
        account: member.account,
        namespaceId: 0,
      },
    ]);

    const pending = await request(app.getHttpServer())
      .post('/api/v1/group/invitations')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId });
    // The listing is the projection history for the direction: the owner's own
    // ACCEPTED founding invitation and the member's live invitation.
    const requestedRows = pending.body.data.data.filter(
      (row: { status: string }) => row.status === 'REQUESTED',
    );
    expect(requestedRows).toHaveLength(1);
    expect(requestedRows[0]).toMatchObject({
      snapshot,
      account: member.account,
      namespaceId: 0,
      status: 'REQUESTED',
    });
    const repeated = await request(app.getHttpServer())
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        groupId: threadId,
        users: [
          {
            account: member.account,
            namespaceId: 0,
            snapshot: {
              displayName: 'Changed during the same request',
              avatar: null,
            },
          },
        ],
      });
    expect(repeated.body.code).toBe(BusinessCode.OK);
    const repeatedHistory = await request(app.getHttpServer())
      .post('/api/v1/group/invitations')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId });
    expect(repeatedHistory.body.data.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: member.account,
          status: 'REQUESTED',
          snapshot,
        }),
      ]),
    );

    const revoked = await request(app.getHttpServer())
      .post('/api/v1/group/invitation/revoke')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        groupId: threadId,
        account: member.account,
        namespaceId: 0,
      });
    expect(revoked.body.code).toBe(BusinessCode.OK);
    const history = await request(app.getHttpServer())
      .post('/api/v1/group/invitations')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId });
    expect(history.body.data.data[0]).toMatchObject({
      status: 'WITHDRAWN',
      snapshot,
    });

    const lateJoin = await request(app.getHttpServer())
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ groupId: threadId });
    expect(lateJoin.body.code).toBe(BusinessCode.NOT_FOUND);
    expect(lateJoin.body.data?.status).not.toBe('APPLIED');

    const nextSnapshot = {
      displayName: 'Member on the next invitation',
      avatar: null,
    };
    const reinvited = await request(app.getHttpServer())
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        groupId: threadId,
        users: [
          { account: member.account, namespaceId: 0, snapshot: nextSnapshot },
        ],
      });
    expect(reinvited.body.code).toBe(BusinessCode.OK);
    const joined = await request(app.getHttpServer())
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ groupId: threadId });
    expect(joined.body.code).toBe(BusinessCode.OK);
    const acceptedHistory = await request(app.getHttpServer())
      .post('/api/v1/group/invitations')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId });
    expect(acceptedHistory.body.data.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: member.account,
          status: 'ACCEPTED',
          snapshot: nextSnapshot,
        }),
      ]),
    );
    const stored = await app
      .get(DatabaseService)
      .db.query.groupRequestProjection.findFirst({
        where: and(
          eq(groupRequestProjection.threadId, threadId),
          eq(groupRequestProjection.memberAccount, member.account),
          eq(groupRequestProjection.profileNamespaceId, 0),
          eq(groupRequestProjection.direction, 'INVITATION'),
        ),
      });
    expect(stored).toMatchObject({
      status: 'ACCEPTED',
      snapshot: nextSnapshot,
    });
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
      columns: { id: true, groupAccount: true },
    });
    expect(thread?.id).toBeTypeOf('number');
    await submitApplication(threadId, applicant.id, 'accept me');
    const pending = await request(app.getHttpServer())
      .post('/api/v1/group/join-requests')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId });
    expect(pending.body.data.data[0]).toMatchObject({
      account: applicant.account,
      namespaceId: 0,
      status: 'REQUESTED',
    });

    const accepted = await request(app.getHttpServer())
      .post('/api/v1/group/join-request/accept')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        groupId: threadId,
        account: applicant.account,
        namespaceId: 0,
      });
    expect(accepted.body.code).toBe(BusinessCode.OK);

    const projections = await database.db.query.groupRequestProjection.findMany(
      {
        where: and(
          eq(groupRequestProjection.threadId, threadId),
          eq(groupRequestProjection.memberAccount, applicant.account),
          eq(groupRequestProjection.profileNamespaceId, 0),
        ),
      },
    );
    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      direction: 'APPLICATION',
      status: 'ACCEPTED',
    });
  });

  it('updates an existing invitation on member ACK without creating an application projection', async () => {
    const owner = await seedUserWithSession(app, 'invitation-ack-owner');
    const member = await seedUserWithSession(app, 'invitation-ack-member');
    const friendRequest = await request(app.getHttpServer())
      .post('/api/v1/relationship/request')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        account: member.account,
        namespaceId: 0,
      });
    await waitForLocalRelationshipRequest(
      app.get(DatabaseService).db,
      friendRequest.body,
      owner.id,
      member.id,
    );
    const friendAccepted = await request(app.getHttpServer())
      .post('/api/v1/relationship/accept')
      .set('Authorization', `Bearer ${member.token}`)
      .send({
        account: owner.account,
        namespaceId: 0,
      });
    expect(friendAccepted.body.data).toMatchObject({ status: 'OK' });
    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Invitation ACK projection' });
    const threadId = created.body.data.threadId as number;
    const invited = await request(app.getHttpServer())
      .post('/api/v1/group/invite')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        groupId: threadId,
        users: [{ account: member.account, namespaceId: 0 }],
      });
    expect(invited.body.code).toBe(BusinessCode.OK);

    const database = app.get(DatabaseService);
    const groupThread = await database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
      columns: { id: true, groupAccount: true },
    });
    expect(groupThread?.id).toBeTypeOf('number');
    const groupIdentity = { account: groupThread!.groupAccount! };
    expect(groupIdentity).toBeDefined();
    await expect(
      database.db.transaction((tx) =>
        readCurrentGroupMemberInTx(tx, groupThread!.id, member.id),
      ),
    ).resolves.toBeUndefined();
    const candidates = await request(app.getHttpServer())
      .post('/api/v1/group/invite-candidates')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, search: member.account });
    expect(candidates.body.data.data).toEqual([
      expect.objectContaining({
        account: member.account,
        domain: localIdentityDomain(),
        namespaceId: 0,
        state: 'INVITED',
      }),
    ]);

    const accepted = await request(app.getHttpServer())
      .post('/api/v1/group/join-request')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ groupId: threadId });
    expect(accepted.body.code).toBe(BusinessCode.OK);

    const acceptedCandidates = await request(app.getHttpServer())
      .post('/api/v1/group/invite-candidates')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ groupId: threadId, search: member.account });
    expect(acceptedCandidates.body.data.data).toEqual([
      expect.objectContaining({
        account: member.account,
        domain: localIdentityDomain(),
        namespaceId: 0,
        state: 'MEMBER',
      }),
    ]);

    const projections = await database.db.query.groupRequestProjection.findMany(
      {
        where: and(
          eq(groupRequestProjection.threadId, threadId),
          eq(groupRequestProjection.memberAccount, member.account),
          eq(groupRequestProjection.profileNamespaceId, 0),
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
    await expect(
      database.db.transaction((tx) =>
        readCurrentGroupMemberInTx(tx, groupThread!.id, member.id),
      ),
    ).resolves.toBeUndefined();
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
        threadId,
        memberAccount: member.account,
        profileNamespaceId: 0,
        memberProfileRev: 1,
        direction: 'APPLICATION',
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
          eq(groupRequestProjection.threadId, threadId),
          eq(groupRequestProjection.memberAccount, member.account),
          eq(groupRequestProjection.profileNamespaceId, 0),
        ),
      }),
    ).toEqual([]);
  });

  it('keeps the shared projection across manager role changes and departure', async () => {
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
      columns: { id: true, groupAccount: true },
    });
    expect(thread?.id).toBeTypeOf('number');
    await database.db.transaction(async (tx) => {
      // Flow-entry group advisory: the mutation writers hold row locks only.
      const thread = await database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
        columns: { groupAccount: true, authorityNamespaceId: true },
      });
      if (!thread?.groupAccount)
        throw new Error('Group thread fixture not found');
      await lockBusinessAccountsInTx(tx, [
        {
          account: thread.groupAccount,
          profileNamespaceId: thread.authorityNamespaceId,
        },
      ]);
      const updates: Array<{ userId: number; feedId: number }> = [];
      const federation = app.get(GroupRelationshipMutationService);
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

    // All managers share one projection per (thread, member, direction): role
    // changes never delete it, they admit the projection fan-out that rebuilds
    // each current manager's join-request watermark.
    const sharedProjections = () =>
      database.db.query.groupRequestProjection.findMany({
        where: and(
          eq(groupRequestProjection.threadId, threadId),
          eq(groupRequestProjection.memberAccount, applicant.account),
          eq(groupRequestProjection.profileNamespaceId, 0),
        ),
      });
    const setRole = (token: string, role: 'ADMIN' | 'MEMBER') =>
      request(app.getHttpServer())
        .post('/api/v1/group/set-role')
        .set('Authorization', `Bearer ${token}`)
        .send({
          groupId: threadId,
          account: admin.account,
          namespaceId: 0,
          role,
        });
    expect(await sharedProjections()).toHaveLength(1);

    const promoted = await setRole(owner.token, 'ADMIN');
    expect(promoted.body.code, JSON.stringify(promoted.body)).toBe(
      BusinessCode.OK,
    );
    expect(await sharedProjections()).toHaveLength(1);
    expect(
      await database.db.query.durableTask.findFirst({
        where: and(
          eq(durableTask.taskType, DurableTaskType.FAN_OUT_GROUP_PROJECTION),
          eq(
            durableTask.coalescingKey,
            JSON.stringify(['FAN_OUT_GROUP_PROJECTION', threadId]),
          ),
        ),
      }),
    ).toBeDefined();

    const demoted = await setRole(owner.token, 'MEMBER');
    expect(demoted.body.code, JSON.stringify(demoted.body)).toBe(
      BusinessCode.OK,
    );
    expect(await sharedProjections()).toHaveLength(1);

    const promotedAgain = await setRole(owner.token, 'ADMIN');
    expect(promotedAgain.body.code).toBe(BusinessCode.OK);
    expect(await sharedProjections()).toHaveLength(1);

    const left = await request(app.getHttpServer())
      .post('/api/v1/group/leave')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ groupId: threadId });
    expect(left.body.code, JSON.stringify(left.body)).toBe(BusinessCode.OK);
    // The owner still manages the same request history after one manager leaves.
    expect(await sharedProjections()).toHaveLength(1);
    expect(await sharedProjections()).toMatchObject([{ status: 'REQUESTED' }]);
  });
});
