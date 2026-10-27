import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq, or } from 'drizzle-orm';
import type {
  GroupRequestPage,
  PersonalRequestPage,
  RequestRecord,
} from '../shared/relationship-request.js';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  relationshipRequest,
  messageThread,
  accountThreadState,
  durableTask,
} from '../src/database/schema.js';
import { DurableTaskType } from '../src/durable-task/durable-task.constants.js';
import { readCurrentGroupMemberInTx } from '../src/group/meta/current-group-roster.js';
import { seedUserWithSession } from './seed.js';
import { createTestApp } from './support/app.js';

type Actor = Awaited<ReturnType<typeof seedUserWithSession>>;
interface GroupFixture {
  threadId: number;
  account: string;
  name: string;
}

describe('permanent group request history and online visibility', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  beforeAll(async () => {
    ({ app, database } = await createTestApp());
  });
  afterAll(async () => app?.close());

  function post(actor: Actor, route: string, body: object) {
    return request(app.getHttpServer())
      .post(`/api/v1/${route}`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send(body);
  }
  async function createGroup(
    owner: Actor,
    name: string,
  ): Promise<GroupFixture> {
    const response = await post(owner, 'group/create', { name });
    expect(response.body.code, JSON.stringify(response.body)).toBe(
      BusinessCode.OK,
    );
    const threadId: number = response.body.data.threadId;
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
    });
    if (!thread?.groupAccount) throw new Error('missing group fixture');
    return { threadId, account: thread.groupAccount, name };
  }
  async function groupPage(
    actor: Actor,
    group: GroupFixture,
    invitations = false,
  ): Promise<GroupRequestPage> {
    const response = await post(
      actor,
      invitations ? 'group/invitations' : 'group/join-requests',
      {
        groupId: group.threadId,
        take: 50,
      },
    );
    expect(response.body.code, JSON.stringify(response.body)).toBe(
      BusinessCode.OK,
    );
    const page: GroupRequestPage = response.body.data;
    expect(page.hasMore).toBe(false);
    return page;
  }
  async function personalPage(
    actor: Actor,
    bucket: 'RECEIVED' | 'SENT' = 'RECEIVED',
  ): Promise<PersonalRequestPage> {
    const response = await post(actor, 'relationship/requests', {
      bucket,
      take: 50,
    });
    expect(response.body.code, JSON.stringify(response.body)).toBe(
      BusinessCode.OK,
    );
    const page: PersonalRequestPage = response.body.data;
    expect(page.hasMore).toBe(false);
    return page;
  }
  async function apply(member: Actor, group: GroupFixture, note: string) {
    const response = await post(member, 'relationship/request', {
      account: group.account,
      namespaceId: 0,
      note,
      snapshot: { displayName: group.name, avatar: null },
    });
    expect(response.body.code, JSON.stringify(response.body)).toBe(
      BusinessCode.OK,
    );
    await vi.waitFor(
      async () => {
        expect(await stored(group, member)).toEqual([
          expect.objectContaining({
            kind: 'GROUP_APPLICATION',
            status: 'REQUESTED',
            note,
          }),
        ]);
      },
      { timeout: 10_000 },
    );
  }
  async function befriend(owner: Actor, member: Actor) {
    const response = await post(owner, 'relationship/request', {
      account: member.account,
      namespaceId: 0,
      snapshot: { displayName: 'Member at friendship request', avatar: null },
    });
    expect(response.body.code, JSON.stringify(response.body)).toBe(
      BusinessCode.OK,
    );
    const incoming = await vi.waitFor(
      async () => {
        const row = (await personalPage(member)).items.find(
          (item) =>
            item.kind === 'FRIEND' &&
            item.author.account === owner.account &&
            item.author.namespaceId === 0 &&
            item.status === 'REQUESTED',
        );
        if (!row) throw new Error('friend request has not arrived');
        return row;
      },
      { timeout: 10_000 },
    );
    const accepted = await post(member, 'relationship/accept', {
      requestId: incoming.id,
    });
    expect(accepted.body.code, JSON.stringify(accepted.body)).toBe(
      BusinessCode.OK,
    );
    expect(accepted.body.data.status).toBe('OK');
  }
  async function invite(
    owner: Actor,
    member: Actor,
    group: GroupFixture,
    displayName: string,
    duplicate = false,
  ) {
    const response = await post(owner, 'group/invite', {
      groupId: group.threadId,
      users: [
        {
          account: member.account,
          namespaceId: 0,
          snapshot: { displayName, avatar: null },
        },
      ],
    });
    expect(response.body.code, JSON.stringify(response.body)).toBe(
      BusinessCode.OK,
    );
    if (duplicate) {
      expect(response.body.data.invited).toEqual([]);
      expect(response.body.data.skipped).toEqual([expect.objectContaining({ account: member.account, namespaceId: 0, reason: 'ALREADY_INVITED', code: BusinessCode.ALREADY_EXISTS })]);
    } else {
      expect(response.body.data.invited).toEqual([{ account: member.account, namespaceId: 0 }]);
      expect(response.body.data.skipped).toEqual([]);
    }
  }
  function stored(group: GroupFixture, member: Actor) {
    return database.db.query.relationshipRequest.findMany({
      where: or(
        and(
          eq(relationshipRequest.kind, 'GROUP_APPLICATION'),
          eq(relationshipRequest.authorAccount, member.account),
          eq(relationshipRequest.authorNamespaceId, 0),
          eq(relationshipRequest.receiverAccount, group.account),
          eq(relationshipRequest.receiverNamespaceId, 0),
        ),
        and(
          eq(relationshipRequest.kind, 'GROUP_INVITATION'),
          eq(relationshipRequest.authorAccount, group.account),
          eq(relationshipRequest.authorNamespaceId, 0),
          eq(relationshipRequest.receiverAccount, member.account),
          eq(relationshipRequest.receiverNamespaceId, 0),
        ),
      ),
      orderBy: relationshipRequest.id,
    });
  }
  function onlyApplication(
    page: GroupRequestPage,
    member: Actor,
  ): RequestRecord {
    const rows = page.items.filter(
      (row) =>
        row.kind === 'GROUP_APPLICATION' &&
        row.author.account === member.account &&
        row.author.namespaceId === 0,
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  it('hides old rejections from online pages without deleting history, even after participation deletion', async () => {
    const owner = await seedUserWithSession(app, 'join-history-owner');
    const applicant = await seedUserWithSession(app, 'join-history-applicant');
    const group = await createGroup(owner, 'Permanent request history');
    await apply(applicant, group, 'please');
    const unauthorized = await post(applicant, 'group/join-requests', {
      groupId: group.threadId,
    });
    expect(unauthorized.body.code).toBe(BusinessCode.THREAD_NOT_FOUND);

    const pending = await vi.waitFor(
      async () => {
        const page = await groupPage(owner, group);
        expect(page.joinRequestEndFeedId).toBeGreaterThan(0);
        return page;
      },
      { timeout: 10_000 },
    );
    const row = onlyApplication(pending, applicant);
    expect(row).toMatchObject({
      status: 'REQUESTED',
      direction: 'INCOMING',
      note: 'please',
    });
    // Read the returned manager watermark, not the unrelated bigint request ID.
    expect(Number.isInteger(pending.joinRequestEndFeedId)).toBe(true);
    expect(pending.joinRequestEndFeedId).toBeGreaterThan(0);
    const read = await post(owner, 'group/join-requests/read', {
      groupId: group.threadId,
      joinRequestReadFeedId: pending.joinRequestEndFeedId,
    });
    expect(read.body.code).toBe(BusinessCode.OK);
    await vi.waitFor(async () => {
      expect(
        await database.db.query.accountThreadState.findFirst({
          where: and(
            eq(accountThreadState.accountId, owner.id),
            eq(accountThreadState.threadId, group.threadId),
          ),
        }),
      ).toMatchObject({
        joinRequestEndFeedId: pending.joinRequestEndFeedId,
        joinRequestReadFeedId: pending.joinRequestEndFeedId,
      });
    });
    const rejected = await post(owner, 'group/join-request/reject', {
      groupId: group.threadId,
      requestId: row.id,
    });
    expect(rejected.body.code).toBe(BusinessCode.OK);
    expect(rejected.body.data.status).toBe('OK');
    expect(
      onlyApplication(await groupPage(owner, group), applicant),
    ).toMatchObject({ id: row.id, status: 'REJECTED' });

    // Age both candidate window clocks so this test does not decide the open
    // createdAt-vs-requestedAt review choice. updatedAt stays recent: a terminal
    // status change must not bring an old request back into the online window.
    const old = new Date(Date.now() - 8 * 86_400_000);
    await database.db
      .update(relationshipRequest)
      .set({
        createdAt: old,
        requestedAt: old,
        expiresAt: new Date(old.getTime() + 7 * 86_400_000),
      })
      .where(eq(relationshipRequest.id, BigInt(row.id)));
    const history = await stored(group, applicant);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: BigInt(row.id),
      status: 'REJECTED',
      note: 'please',
    });
    expect((await groupPage(owner, group)).items).toEqual([]);
    expect((await personalPage(applicant, 'SENT')).items).toEqual([]);
    expect(await stored(group, applicant)).toEqual(history);

    await database.db
      .delete(accountThreadState)
      .where(
        and(
          eq(accountThreadState.threadId, group.threadId),
          eq(accountThreadState.accountId, owner.id),
        ),
      );
    expect(await stored(group, applicant)).toEqual(history);
  });

  it('preserves invitation rounds and snapshots through retry, withdrawal and re-invitation', async () => {
    const owner = await seedUserWithSession(app, 'invitation-history-owner');
    const member = await seedUserWithSession(app, 'invitation-history-member');
    await befriend(owner, member);
    const group = await createGroup(owner, 'Invitation history');
    await invite(owner, member, group, 'Member at invitation time');
    const pending = await groupPage(owner, group, true);
    const rounds = pending.items.filter(
      (row) =>
        row.receiver.account === member.account &&
        row.receiver.namespaceId === 0,
    );
    expect(rounds).toHaveLength(1);
    const first = rounds[0];
    expect(first).toMatchObject({
      kind: 'GROUP_INVITATION',
      direction: 'OUTGOING',
      status: 'REQUESTED',
      snapshot: { displayName: 'Member at invitation time', avatar: null },
    });
    const firstStored = await stored(group, member);
    await invite(owner, member, group, 'Changed during the same request', true);
    expect(await groupPage(owner, group, true)).toEqual(pending);
    expect(await stored(group, member)).toEqual(firstStored);

    const withdrawn = await post(owner, 'group/invitation/revoke', {
      groupId: group.threadId,
      requestId: first.id,
    });
    expect(withdrawn.body.code).toBe(BusinessCode.OK);
    expect(withdrawn.body.data.status).toBe('OK');
    const withdrawnStored = await stored(group, member);
    expect(withdrawnStored).toHaveLength(1);
    expect(withdrawnStored[0]).toMatchObject({
      status: 'WITHDRAWN',
      snapshot: { displayName: 'Member at invitation time', avatar: null },
    });
    const late = await post(member, 'group/join-request', {
      requestId: first.id,
    });
    expect(late.body.code).toBe(BusinessCode.OK);
    expect(late.body.data).toEqual({ status: 'STALE_REQUEST' });

    await invite(owner, member, group, 'Member on the next invitation');
    const nextRounds = (await groupPage(owner, group, true)).items.filter(
      (row) =>
        row.receiver.account === member.account &&
        row.receiver.namespaceId === 0,
    );
    expect(nextRounds).toHaveLength(2);
    const next = nextRounds[0];
    expect(BigInt(next.id)).toBeGreaterThan(BigInt(first.id));
    expect(next).toMatchObject({
      status: 'REQUESTED',
      snapshot: { displayName: 'Member on the next invitation', avatar: null },
    });
    const beforeStale = await stored(group, member);
    const stale = await post(member, 'group/join-request', {
      requestId: first.id,
    });
    expect(stale.body.data).toEqual({ status: 'STALE_REQUEST' });
    expect(await stored(group, member)).toEqual(beforeStale);
    const joined = await post(member, 'group/join-request', {
      requestId: next.id,
    });
    expect(joined.body.code).toBe(BusinessCode.OK);
    expect(joined.body.data.status).toBe('OK');
    const acceptedHistory = await stored(group, member);
    expect(acceptedHistory).toHaveLength(2);
    expect(acceptedHistory[0]).toEqual(withdrawnStored[0]);
    expect(acceptedHistory[1]).toMatchObject({
      id: BigInt(next.id),
      status: 'ACCEPTED',
      snapshot: { displayName: 'Member on the next invitation', avatar: null },
    });
  });

  it('accepts an application without manufacturing an invitation record', async () => {
    const owner = await seedUserWithSession(app, 'application-ack-owner');
    const applicant = await seedUserWithSession(app, 'application-ack-member');
    const group = await createGroup(owner, 'Application ACK history');
    await apply(applicant, group, 'accept me');
    const row = onlyApplication(await groupPage(owner, group), applicant);
    const accepted = await post(owner, 'group/join-request/accept', {
      groupId: group.threadId,
      requestId: row.id,
    });
    expect(accepted.body.code).toBe(BusinessCode.OK);
    expect(accepted.body.data.status).toBe('OK');
    const history = await stored(group, applicant);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: BigInt(row.id),
      kind: 'GROUP_APPLICATION',
      status: 'ACCEPTED',
    });
  });

  it('accepts an invitation without manufacturing an application and preserves it after leaving', async () => {
    const owner = await seedUserWithSession(app, 'invitation-ack-owner');
    const member = await seedUserWithSession(app, 'invitation-ack-member');
    await befriend(owner, member);
    const group = await createGroup(owner, 'Invitation ACK history');
    await invite(owner, member, group, 'Member at invitation');
    await expect(
      database.db.transaction((tx) =>
        readCurrentGroupMemberInTx(tx, group.threadId, member.id),
      ),
    ).resolves.toBeUndefined();
    // Candidate listing is gone: the owner's INVITED/MEMBER view is now the
    // group's outgoing invitation rounds plus duplicate-invite rejections.
    const pending = await groupPage(owner, group, true);
    expect(
      pending.items.filter(
        (row) =>
          row.receiver.account === member.account &&
          row.receiver.namespaceId === 0,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'GROUP_INVITATION',
        direction: 'OUTGOING',
        status: 'REQUESTED',
      }),
    ]);
    const received = (await personalPage(member)).items.filter(
      (row) =>
        row.kind === 'GROUP_INVITATION' &&
        row.author.account === group.account &&
        row.author.namespaceId === 0,
    );
    expect(received).toHaveLength(1);
    const accepted = await post(member, 'group/join-request', {
      requestId: received[0].id,
    });
    expect(accepted.body.code).toBe(BusinessCode.OK);
    expect(accepted.body.data.status).toBe('OK');
    const acceptedPage = await groupPage(owner, group, true);
    expect(
      acceptedPage.items.filter(
        (row) =>
          row.receiver.account === member.account &&
          row.receiver.namespaceId === 0,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'GROUP_INVITATION',
        direction: 'OUTGOING',
        status: 'ACCEPTED',
      }),
    ]);
    const memberProbe = await post(owner, 'group/invite', {
      groupId: group.threadId,
      users: [
        {
          account: member.account,
          namespaceId: 0,
          snapshot: { displayName: 'Member at invitation', avatar: null },
        },
      ],
    });
    expect(memberProbe.body.code).toBe(BusinessCode.OK);
    expect(memberProbe.body.data.invited).toEqual([]);
    expect(memberProbe.body.data.skipped).toEqual([
      expect.objectContaining({
        account: member.account,
        namespaceId: 0,
        reason: 'ALREADY_MEMBER',
      }),
    ]);
    const history = await stored(group, member);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: BigInt(received[0].id),
      kind: 'GROUP_INVITATION',
      status: 'ACCEPTED',
    });
    const left = await post(member, 'group/leave', { groupId: group.threadId });
    expect(left.body.code).toBe(BusinessCode.OK);
    await expect(
      database.db.transaction((tx) =>
        readCurrentGroupMemberInTx(tx, group.threadId, member.id),
      ),
    ).resolves.toBeUndefined();
    expect(await stored(group, member)).toEqual(history);
  });

  it('does not manufacture history when a terminal action refers to a missing round', async () => {
    const owner = await seedUserWithSession(app, 'terminal-effect-owner');
    const member = await seedUserWithSession(app, 'terminal-effect-member');
    const group = await createGroup(owner, 'Missing round');
    const requestId = '9223372036854775807';
    expect(
      await database.db.query.relationshipRequest.findFirst({
        where: eq(relationshipRequest.id, BigInt(requestId)),
      }),
    ).toBeUndefined();
    expect(await stored(group, member)).toEqual([]);
    const response = await post(owner, 'group/join-request/accept', {
      groupId: group.threadId,
      requestId,
    });
    expect(response.body.code).toBe(BusinessCode.OK);
    expect(response.body.data).toEqual({ status: 'STALE_REQUEST' });
    expect(await stored(group, member)).toEqual([]);
    expect((await groupPage(owner, group)).items).toEqual([]);
  });

  it('preserves shared history across manager promotion, demotion and departure', async () => {
    const owner = await seedUserWithSession(app, 'join-role-owner');
    const admin = await seedUserWithSession(app, 'join-role-admin');
    const applicant = await seedUserWithSession(app, 'join-role-applicant');
    await befriend(owner, admin);
    const group = await createGroup(owner, 'Role request history');
    await invite(owner, admin, group, 'Admin before promotion');
    const received = (await personalPage(admin)).items.filter(
      (row) =>
        row.kind === 'GROUP_INVITATION' &&
        row.author.account === group.account &&
        row.author.namespaceId === 0,
    );
    expect(received).toHaveLength(1);
    const joined = await post(admin, 'group/join-request', {
      requestId: received[0].id,
    });
    expect(joined.body.code).toBe(BusinessCode.OK);
    expect(joined.body.data.status).toBe('OK');
    await apply(applicant, group, 'admin should see this');
    const history = await stored(group, applicant);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('REQUESTED');
    const setRole = (role: 'ADMIN' | 'MEMBER') =>
      post(owner, 'group/set-role', {
        groupId: group.threadId,
        account: admin.account,
        namespaceId: 0,
        role,
      });
    const promoted = await setRole('ADMIN');
    expect(promoted.body.code, JSON.stringify(promoted.body)).toBe(
      BusinessCode.OK,
    );
    expect(await stored(group, applicant)).toEqual(history);
    expect(onlyApplication(await groupPage(admin, group), applicant).id).toBe(
      history[0].id.toString(),
    );
    expect(
      await database.db.query.durableTask.findFirst({
        where: and(
          eq(durableTask.taskType, DurableTaskType.FAN_OUT_GROUP_PROJECTION),
          eq(
            durableTask.coalescingKey,
            JSON.stringify(['FAN_OUT_GROUP_PROJECTION', group.threadId]),
          ),
        ),
      }),
    ).toBeDefined();
    const demoted = await setRole('MEMBER');
    expect(demoted.body.code, JSON.stringify(demoted.body)).toBe(
      BusinessCode.OK,
    );
    expect(await stored(group, applicant)).toEqual(history);
    const denied = await post(admin, 'group/join-requests', {
      groupId: group.threadId,
    });
    expect(denied.body.code).toBe(BusinessCode.GROUP_FORBIDDEN);
    const promotedAgain = await setRole('ADMIN');
    expect(promotedAgain.body.code).toBe(BusinessCode.OK);
    expect(onlyApplication(await groupPage(admin, group), applicant).id).toBe(
      history[0].id.toString(),
    );
    const left = await post(admin, 'group/leave', { groupId: group.threadId });
    expect(left.body.code, JSON.stringify(left.body)).toBe(BusinessCode.OK);
    expect(await stored(group, applicant)).toEqual(history);
    expect(onlyApplication(await groupPage(owner, group), applicant).id).toBe(
      history[0].id.toString(),
    );
  });
});
