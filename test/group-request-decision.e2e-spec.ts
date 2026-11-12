import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq, or } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  accountThreadState,
  durableTask,
  groupMeta,
  groupMetaMemberFeed,
  message,
  messageThread,
  relationshipIntent,
  relationshipPair,
  relationshipRequest,
  threadAudience,
} from '../src/database/schema.js';
import { RequestTransactionCapability } from '../src/relationship/request/request-transaction.contract.js';
import { GroupAuthoredMembershipIntentService } from '../src/group/membership-intent/authored/group-authored-membership-intent.service.js';
import { DurableTaskSchedulerService } from '../src/durable-task/durable-task-scheduler.service.js';
import { seedUserWithSession } from './seed.js';
import { createTestApp } from './support/app.js';

type Actor = Awaited<ReturnType<typeof seedUserWithSession>>;

describe('exact group request decisions through membership transactions', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let sequence = 0;
  beforeAll(async () => {
    ({ app, database } = await createTestApp());
    // Observe admission atomically without background tasks consuming the rows.
    await app.get(DurableTaskSchedulerService).stop();
  });
  afterAll(async () => app?.close());

  function post(actor: Actor, route: string, body: object) {
    return request(app.getHttpServer())
      .post(`/api/v1/${route}`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send(body);
  }
  function ok(response: { body: { code: number; data: unknown } }) {
    expect(response.body.code, JSON.stringify(response.body)).toBe(
      BusinessCode.OK,
    );
  }
  async function fixture() {
    const prefix = `round-${++sequence}`;
    const owner = await seedUserWithSession(app, `${prefix}-owner`);
    const member = await seedUserWithSession(app, `${prefix}-member`);
    const response = await post(owner, 'group/create', { name: prefix });
    ok(response);
    const threadId: number = response.body.data.threadId;
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
    });
    if (!thread?.groupAccount) throw new Error('missing group');
    return { owner, member, threadId, group: thread.groupAccount };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function open(f: Fixture, invitation = false) {
    const response = invitation
      ? await post(f.owner, 'group/invite', {
          groupId: f.threadId,
          users: [
            {
              account: f.member.account,
              namespaceId: 0,
              snapshot: { displayName: 'Invitee', avatar: null },
            },
          ],
        })
      : await post(f.member, 'relationship/request', {
          account: f.group,
          namespaceId: 0,
          snapshot: { displayName: 'Group', avatar: null },
          note: 'join please',
        });
    ok(response);
    const [round] = await database.db
      .select()
      .from(relationshipRequest)
      .where(
        and(
          eq(
            relationshipRequest.kind,
            invitation ? 'GROUP_INVITATION' : 'GROUP_APPLICATION',
          ),
          eq(
            relationshipRequest.authorAccount,
            invitation ? f.group : f.member.account,
          ),
          eq(
            relationshipRequest.receiverAccount,
            invitation ? f.member.account : f.group,
          ),
          eq(relationshipRequest.status, 'REQUESTED'),
        ),
      );
    if (!round) throw new Error('missing request round');
    return round;
  }
  function round(id: bigint) {
    return database.db.query.relationshipRequest.findFirst({
      where: eq(relationshipRequest.id, id),
    });
  }
  async function state(f: Fixture) {
    const db = database.db;
    return {
      thread: await db.query.messageThread.findFirst({
        where: eq(messageThread.id, f.threadId),
      }),
      pair: await db.query.relationshipPair.findFirst({
        where: and(
          eq(relationshipPair.threadId, f.threadId),
          eq(relationshipPair.endpointBAccount, f.member.account),
        ),
      }),
      intents: await db
        .select()
        .from(relationshipIntent)
        .where(
          or(
            and(
              eq(relationshipIntent.authorAccount, f.group),
              eq(relationshipIntent.receiverAccount, f.member.account),
            ),
            and(
              eq(relationshipIntent.authorAccount, f.member.account),
              eq(relationshipIntent.receiverAccount, f.group),
            ),
          ),
        )
        .orderBy(relationshipIntent.authorAccount),
      participant: await db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.threadId, f.threadId),
          eq(accountThreadState.accountId, f.member.id),
        ),
      }),
      meta: await db.query.groupMeta.findFirst({
        where: eq(groupMeta.threadId, f.threadId),
      }),
      roster: await db
        .select()
        .from(groupMetaMemberFeed)
        .where(eq(groupMetaMemberFeed.threadId, f.threadId))
        .orderBy(groupMetaMemberFeed.feedId),
      messages: await db
        .select()
        .from(message)
        .where(eq(message.threadId, f.threadId))
        .orderBy(message.seq),
      audiences: await db
        .select()
        .from(threadAudience)
        .where(eq(threadAudience.threadId, f.threadId))
        .orderBy(threadAudience.id),
      tasks: await db.select().from(durableTask).orderBy(durableTask.id),
    };
  }

  it('invites a local non-friend without admitting membership until acceptance and rejects non-manager invitations', async () => {
    const f = await fixture();
    const friendship = await database.db.query.relationshipPair.findFirst({
      where: and(
        eq(relationshipPair.kind, 'P2P'),
        or(
          and(
            eq(relationshipPair.endpointAAccount, f.owner.account),
            eq(relationshipPair.endpointBAccount, f.member.account),
          ),
          and(
            eq(relationshipPair.endpointAAccount, f.member.account),
            eq(relationshipPair.endpointBAccount, f.owner.account),
          ),
        ),
      ),
    });
    expect(friendship).toBeUndefined();
    const invitation = await open(f, true);
    const pending = await state(f);
    expect(pending.pair?.active).toBe(false);
    expect(pending.participant).toBeUndefined();

    const inviteBody = {
      groupId: f.threadId,
      users: [
        {
          account: f.member.account,
          namespaceId: 0,
          snapshot: { displayName: 'Invitee', avatar: null },
        },
      ],
    };
    const duplicate = await post(f.owner, 'group/invite', inviteBody);
    ok(duplicate);
    expect(duplicate.body.data).toMatchObject({
      invited: [],
      skipped: [{ reason: 'ALREADY_INVITED' }],
    });

    const accepted = await post(f.member, 'group/join-request', {
      requestId: invitation.id.toString(),
    });
    ok(accepted);
    expect(accepted.body.data.status).toBe('OK');
    const joined = await state(f);
    expect(joined.pair?.active).toBe(true);
    expect(joined.participant).toBeDefined();

    const alreadyMember = await post(f.owner, 'group/invite', inviteBody);
    ok(alreadyMember);
    expect(alreadyMember.body.data).toMatchObject({
      invited: [],
      skipped: [{ reason: 'ALREADY_MEMBER' }],
    });
    const outsider = await seedUserWithSession(
      app,
      `round-${sequence}-outsider`,
    );
    const forbidden = await post(f.member, 'group/invite', {
      groupId: f.threadId,
      users: [
        {
          account: outsider.account,
          namespaceId: 0,
          snapshot: { displayName: 'Outsider', avatar: null },
        },
      ],
    });
    ok(forbidden);
    expect(forbidden.body.data).toMatchObject({
      invited: [],
      skipped: [{ reason: 'FORBIDDEN', code: BusinessCode.GROUP_FORBIDDEN }],
    });
  });

  it('declines an invitation and withdraws a renewed application without departure effects', async () => {
    const f = await fixture();
    const invitation = await open(f, true);
    const before = await state(f);
    const wrongSide = await post(f.owner, 'group/invitation/decline', {
      requestId: invitation.id.toString(),
    });
    ok(wrongSide);
    expect(wrongSide.body.data.status).toBe('STALE_REQUEST');
    const declined = await post(f.member, 'group/invitation/decline', {
      requestId: invitation.id.toString(),
    });
    ok(declined);
    expect(declined.body.data).toEqual({ status: 'OK', threadId: f.threadId });
    expect((await round(invitation.id))?.status).toBe('REJECTED');
    const after = await state(f);
    expect(after.pair?.active).toBe(false);
    expect(after.messages).toEqual(before.messages);
    expect(after.roster).toEqual(before.roster);
    expect(after.intents.map((i) => i.status)).toEqual(['REVOKED', 'REVOKED']);
    expect(after.intents.every((i) => i.expiresAt === null)).toBe(true);
    const closed = await round(invitation.id);
    const replay = await post(f.member, 'group/invitation/decline', {
      requestId: invitation.id.toString(),
    });
    expect(replay.body.data.status).toBe('STALE_REQUEST');
    expect(await round(invitation.id)).toEqual(closed);

    const application = await open(f);
    const withdrawn = await post(f.member, 'group/join-request/withdraw', {
      requestId: application.id.toString(),
    });
    ok(withdrawn);
    expect(withdrawn.body.data.status).toBe('OK');
    expect((await round(application.id))?.status).toBe('WITHDRAWN');
    const next = await open(f);
    expect(next.id).toBeGreaterThan(application.id);
    const stale = await post(f.member, 'group/join-request/withdraw', {
      requestId: application.id.toString(),
    });
    expect(stale.body.data.status).toBe('STALE_REQUEST');
    expect(await round(next.id)).toEqual(next);
    expect((await state(f)).messages).toEqual(before.messages);
  });

  it('gates manager decisions by group, kind, live association and current authority', async () => {
    const f = await fixture();
    const application = await open(f);
    const other = await fixture();
    const before = await state(f);
    const wrongGroup = await post(other.owner, 'group/join-request/accept', {
      groupId: other.threadId,
      requestId: application.id.toString(),
    });
    expect(wrongGroup.body.data.status).toBe('STALE_REQUEST');
    const wrongKind = await post(f.owner, 'group/invitation/revoke', {
      groupId: f.threadId,
      requestId: application.id.toString(),
    });
    expect(wrongKind.body.data.status).toBe('STALE_REQUEST');
    const unauthorized = await app
      .get(GroupAuthoredMembershipIntentService)
      .execute(
        {
          threadId: f.threadId,
          managerUserId: other.owner.id,
          decision: 'ACCEPTED',
          target: { account: f.member.account, namespaceId: 0 },
          scope: 'APPLICATION',
        },
        { requestDecision: { requestId: application.id, decision: 'ACCEPT' } },
      );
    expect(unauthorized).toMatchObject({
      status: 'REJECTED',
      reason: 'FORBIDDEN',
    });
    expect(await state(f)).toEqual(before);
    expect(await round(application.id)).toEqual(application);
    // A missing association must not fall back to the endpoint's current intent.
    await database.db
      .update(relationshipIntent)
      .set({ requestId: null })
      .where(eq(relationshipIntent.requestId, application.id));
    const detached = await post(f.owner, 'group/join-request/accept', {
      groupId: f.threadId,
      requestId: application.id.toString(),
    });
    expect(detached.body.data.status).toBe('STALE_REQUEST');
    expect(await round(application.id)).toEqual(application);
  });

  it('serializes competing exact approvals and commits roster, notice and task admission once', async () => {
    const f = await fixture();
    const application = await open(f);
    const before = await state(f);
    const results = await Promise.all(
      [1, 2].map(() =>
        post(f.owner, 'group/join-request/accept', {
          groupId: f.threadId,
          requestId: application.id.toString(),
        }),
      ),
    );
    results.forEach(ok);
    expect(results.map((r) => r.body.data.status).sort()).toEqual([
      'OK',
      'STALE_REQUEST',
    ]);
    const after = await state(f);
    expect(after.pair).toMatchObject({ active: true, established: true });
    expect(after.participant?.role).toBe('MEMBER');
    expect(after.audiences.some((a) => a.localUserId === f.member.id)).toBe(
      true,
    );
    expect(
      after.roster.some(
        (r) =>
          r.operation === 'MEMBER_UPSERT' &&
          (r.body as { account: string }).account === f.member.account,
      ),
    ).toBe(true);
    expect(after.messages).toHaveLength(before.messages.length + 1);
    expect(JSON.parse(after.messages.at(-1)!.content)).toMatchObject({
      type: 'GROUP_JOINED',
    });
    expect(after.thread!.curSeq).toBe(before.thread!.curSeq + 1);
    // Existing PENDING work is advanced in place; admission need not mint a new ID.
    const tasks = after.tasks.filter(
      (t) =>
        (t.payload as { threadId?: number }).threadId === f.threadId &&
        [
          'FAN_OUT_THREAD_CONTENT',
          'FAN_OUT_FEDERATION_THREAD_CONTENT',
        ].includes(t.taskType),
    );
    expect(tasks.map((t) => t.taskType).sort()).toEqual([
      'FAN_OUT_FEDERATION_THREAD_CONTENT',
      'FAN_OUT_THREAD_CONTENT',
    ]);
    for (const task of tasks)
      expect(task.payload).toMatchObject({
        messageEndSeq: after.thread!.curSeq,
      });
    expect((await round(application.id))?.status).toBe('ACCEPTED');
  });

  it('rolls back canonical effects when request conclusion fails', async () => {
    const f = await fixture();
    const application = await open(f);
    const before = await state(f);
    const fail = vi
      .spyOn(app.get(RequestTransactionCapability), 'concludeRequestInTx')
      .mockRejectedValueOnce(new Error('injected request conclusion failure'));
    try {
      const response = await post(f.owner, 'group/join-request/accept', {
        groupId: f.threadId,
        requestId: application.id.toString(),
      });
      expect(response.body.code).not.toBe(BusinessCode.OK);
    } finally {
      fail.mockRestore();
    }
    expect(await state(f)).toEqual(before);
    expect(await round(application.id)).toEqual(application);
  });

  it('returns EXPIRED without altering the round or incoming heads', async () => {
    const f = await fixture();
    const invitation = await open(f, true);
    const statusChangedAt = new Date(Date.now() - 2000);
    const expiresAt = new Date(Date.now() - 1000);
    await database.db
      .update(relationshipRequest)
      .set({ requestedAt: statusChangedAt, expiresAt })
      .where(eq(relationshipRequest.id, invitation.id));
    await database.db
      .update(relationshipIntent)
      .set({ statusChangedAt, expiresAt })
      .where(eq(relationshipIntent.requestId, invitation.id));
    const before = await state(f);
    const stored = await round(invitation.id);
    const head = await database.db.query.account.findFirst({
      where: eq(account.id, f.member.id),
    });
    for (const route of ['group/join-request', 'group/invitation/decline']) {
      const response = await post(f.member, route, {
        requestId: invitation.id.toString(),
      });
      ok(response);
      expect(response.body.data.status).toBe('EXPIRED');
    }
    const response = await post(f.owner, 'group/invitation/revoke', {
      groupId: f.threadId,
      requestId: invitation.id.toString(),
    });
    ok(response);
    expect(response.body.data.status).toBe('EXPIRED');
    expect(await state(f)).toEqual(before);
    expect(await round(invitation.id)).toEqual(stored);
    expect(
      await database.db.query.account.findFirst({
        where: eq(account.id, f.member.id),
      }),
    ).toEqual(head);
  });
});
