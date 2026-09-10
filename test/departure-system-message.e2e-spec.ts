import { FederationRelationshipTaskHandler } from '../src/federation/federation-relationship-task.handler.js';
import { FederationThreadQueryDenialService } from '../src/federation/federation-thread-query-denial.service.js';
import { FederationThreadSourceInactiveError } from '../src/federation/federation-errors.js';
import { RevokeForbiddenGroupTaskHandler } from '../src/group/revoke-forbidden-group-task.handler.js';
import { ForceRevokeGroupMemberTaskHandler } from '../src/group/force-revoke-group-member-task.handler.js';
import { GroupRevokeFanoutService } from '../src/group/group-revoke-fanout.service.js';
import { FederationThreadSourceService } from '../src/federation/federation-thread-source.service.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import {
  groupState as group,
  readGroupState,
} from '../src/group/group-state.js';
import type { AccountTarget } from '../src/user/account-address.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq, and, asc, sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  groupAccount,
  groupMetaFeed,
  groupMetaMemberFeed,
  groupMetaProfileFeed,
  messageThread,
  message,
  accountThreadState,
  durableTask,
} from '../src/database/schema.js';
import { GroupService } from '../src/group/group.service.js';
import { MessageService } from '../src/message/message.service.js';
import { ThreadFanoutTaskHandler } from '../src/message/thread-fanout-task.handler.js';
import { DurableTaskStoreService } from '../src/durable-task/durable-task-store.service.js';
import { DurableTaskType } from '../src/durable-task/durable-task.constants.js';
import { RelationshipService } from '../src/relationship/relationship.service.js';
import { RelationshipIntentService } from '../src/relationship/relationship-intent.service.js';
import { AccountThreadStateService } from '../src/account-thread-state/account-thread-state.service.js';
import { RevokeUserRelationshipTaskHandler } from '../src/relationship/revoke-user-relationship-task.handler.js';
import { FederationGroupRelationshipService } from '../src/federation/federation-group-relationship.service.js';
import { FederationStateFeedConsumerService } from '../src/federation/federation-state-feed-consumer.service.js';
import { GroupMetaSyncTaskExecutionService } from '../src/federation/group-meta-sync-task-execution.service.js';
import { mintGroupAccount } from '../src/common/account.js';
import { loadFederationConfig } from '../src/federation/federation.config.js';
import {
  seedUserWithSession,
  seedFederatedPeerNamespace,
  findGroupRelationship,
  findP2PRelationship,
} from './seed.js';

describe('departure system message paths', () => {
  let app: TestingModule;
  let database: DatabaseService;
  let groups: GroupService;
  let relationships: RelationshipService;
  let intents: RelationshipIntentService;
  let memberships: FederationGroupRelationshipService;
  let consumer: FederationStateFeedConsumerService;
  let serial = 0;
  beforeAll(async () => {
    // Real services and PostgreSQL, without starting background task dispatch or network listeners.
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = app.get(DatabaseService);
    groups = app.get(GroupService);
    relationships = app.get(RelationshipService);
    intents = app.get(RelationshipIntentService);
    memberships = app.get(FederationGroupRelationshipService);
    consumer = app.get(FederationStateFeedConsumerService);
  });
  afterAll(async () => app.close());
  const identity = () =>
    seedUserWithSession(
      app as unknown as INestApplication,
      `departure-${++serial}`,
    );
  async function notices(threadId: number, type = 'GROUP_LEFT') {
    const rows = await database.db
      .select()
      .from(message)
      .where(eq(message.threadId, threadId))
      .orderBy(asc(message.seq));
    return rows.filter((row) => JSON.parse(row.content).type === type);
  }
  async function boundary(threadId: number, userId: number) {
    return database.db.query.accountThreadState.findFirst({
      where: and(
        eq(accountThreadState.threadId, threadId),
        eq(accountThreadState.accountId, userId),
      ),
    });
  }
  async function assertHeads(threadId: number, ids: number[], seq: number) {
    const queued = await database.db.query.durableTask.findFirst({
      where: and(
        eq(durableTask.scopeKey, JSON.stringify(['THREAD_FANOUT', threadId])),
        eq(durableTask.taskType, DurableTaskType.FAN_OUT_THREAD_CONTENT),
        eq(durableTask.status, 'PENDING'),
      ),
    });
    expect(queued?.payload).toMatchObject({ threadId, messageEndSeq: seq });
    const active = new Set(
      (
        await app
          .get(AccountThreadStateService)
          .getActiveParticipantUserIds(threadId)
      ).map((row) => row.userId),
    );
    const before = new Map(
      await Promise.all(
        ids.map(async (id) => [id, await boundary(threadId, id)] as const),
      ),
    );
    // This suite does not start the scheduler. Execute the real persisted task explicitly.
    const store = app.get(DurableTaskStoreService);
    const claimed = await store.claim(queued!.id);
    expect(claimed).toBeDefined();
    await app.get(ThreadFanoutTaskHandler).execute(claimed!);
    await store.markSucceeded(claimed!.id);
    for (const id of ids) {
      const state = await boundary(threadId, id);
      expect(state).toBeDefined();
      if (active.has(id)) {
        expect(state!.messageEndSeq).toBe(seq);
        expect(state!.threadFeedId).toBeGreaterThan(0);
      } else {
        // Leaving the audience does not retain a final content-fanout recipient.
        expect(state!.messageEndSeq).toBe(before.get(id)!.messageEndSeq);
        expect(state!.threadFeedId).toBe(before.get(id)!.threadFeedId);
      }
    }
  }
  async function activate(
    groupId: number,
    threadId: number,
    memberId: AccountTarget,
    hostedLocally: boolean,
  ) {
    await database.db.transaction(async (tx) => {
      for (const author of ['GROUP', 'MEMBER', 'GROUP'] as const)
        await intents.writeGroupAuthoredIntentInTx(tx, {
          groupId,
          threadId,
          memberUserId: memberId,
          author,
          status: 'REQUESTED',
        });
      await memberships.syncActiveInTx(tx, {
        groupId,
        threadId,
        memberUserId: memberId,
        hostedLocally,
        active: true,
      });
    });
  }
  async function hosted() {
    const owner = await identity(),
      member = await identity();
    const created = await groups.createNewGroup({
      name: 'Departures',
      owner: owner.id,
    });
    const threadId = created.threadId;
    const state = await database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
    });
    const groupId = state!.id;
    await activate(groupId, threadId, member.id, true);
    return { owner, member, threadId, groupId };
  }
  async function mirror() {
    const member = await identity(),
      observer = await identity();
    const peerDomain = 'departure-origin.test';
    const namespaceId = await seedFederatedPeerNamespace(
      database.db,
      peerDomain,
    );
    const groupAddress = mintGroupAccount();
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'GROUP',
        groupAccount: groupAddress,
        groupDomain: peerDomain,
        updatedAt: new Date(),
        authorityNamespaceId: namespaceId,
      })
      .returning();
    const parent = {
      id: thread.id,
      account: groupAddress,
      domain: peerDomain,
      namespaceId,
    };
    const sourceMembers = [
      { account: `remote-owner-${++serial}`, domain: peerDomain, namespaceId },
      { account: member.account, domain: 'local', namespaceId: 0 },
      { account: observer.account, domain: 'local', namespaceId: 0 },
      { account: `remote-member-${++serial}`, domain: peerDomain, namespaceId },
    ];
    await database.db.insert(groupMetaMemberFeed).values(
      sourceMembers.map((row, index) => ({
        threadId: parent.id,
        feedId: BigInt(index + 2),
        memberAccount: row.account,
        memberDomain: row.domain,
        memberNamespaceId: row.namespaceId,
        operation: 'UPSERT' as const,
        body: { role: index === 0 ? 'OWNER' : 'MEMBER', profileRev: 1 },
      })),
    );
    await database.db
      .insert(groupMetaFeed)
      .values({ threadId: parent.id, feedEndId: 5n });
    await database.db
      .insert(groupMetaProfileFeed)
      .values({ threadId: parent.id, feedId: 1n, profileRev: 1 });
    for (const local of [member, observer])
      await activate(parent.id, thread.id, local.id, false);
    return {
      member,
      observer,
      parent,
      threadId: thread.id,
      groupId: parent.id,
      peerDomain,
      namespaceId,
      sourceMembers,
    };
  }
  async function revokePeer(target: {
    peerDomain: string;
    namespaceId: number;
    groupAccount: string;
    memberAccount: string;
    invite: boolean;
  }) {
    const effect = await database.db.transaction((tx) =>
      consumer.applyPageInTx(tx, target.peerDomain, target.namespaceId, {
        items: [
          {
            account: target.invite ? target.groupAccount : target.memberAccount,
            peerAccount: target.invite
              ? target.memberAccount
              : target.groupAccount,
            eventType: 'RELATIONSHIP_INTENT',
            feedId: '20',
            body: {
              status: 'REVOKED',
              note: '',
              profileRev: 0,
              requestedAt: null,
              expiresAt: null,
            },
          },
        ],
        scannedThrough: '20',
        stateFeedEndId: '20',
        hasMore: false,
      }),
    );
    const pending = await database.db.query.durableTask.findFirst({
      where: and(
        eq(
          durableTask.taskType,
          DurableTaskType.APPLY_FEDERATED_RELATIONSHIP_INTENT,
        ),
        eq(durableTask.status, 'PENDING'),
        sql`${durableTask.payload}->>'namespaceId' = ${String(target.namespaceId)}`,
      ),
    });
    if (pending) {
      const store = app.get(DurableTaskStoreService);
      await app
        .get(FederationRelationshipTaskHandler)
        .execute((await store.claim(pending.id))!);
      await store.markSucceeded(pending.id);
    }
    return effect;
  }

  it.each(['leave', 'kick', 'dissolve'] as const)(
    'writes one boundary for local %s and none for replay',
    async (path) => {
      const h = await hosted();
      if (path === 'dissolve')
        await database.db
          .update(groupAccount)
          .set({ dissolvedAt: new Date() })
          .where(
            eq(
              groupAccount.id,
              (await database.db.query.messageThread.findFirst({
                where: eq(messageThread.id, h.threadId),
              }))!.groupAccountId!,
            ),
          );
      const run = () =>
        path === 'kick'
          ? groups.kickMember({
              threadId: h.threadId,
              operatorUserId: h.owner.id,
              targetUserId: h.member.id,
            })
          : groups.leaveGroup({
              threadId: h.threadId,
              userId: h.member.id,
              dissolvedFanout: path === 'dissolve',
            });
      await run();
      await run();
      const rows = await notices(h.threadId);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].content).member.account).toBe(h.member.account);
      expect(
        (await boundary(h.threadId, h.member.id))?.messageVisibleThroughSeq,
      ).toBe(rows[0].seq);
      await assertHeads(
        h.threadId,
        path === 'dissolve' ? [h.member.id] : [h.owner.id, h.member.id],
        rows[0].seq,
      );
      expect(
        (await findGroupRelationship(database.db, h.groupId, h.member.id)).pair
          ?.active,
      ).toBe(false);
    },
  );

  it('does not call a pending request withdrawal a group departure', async () => {
    const h = await hosted(),
      pending = await identity();
    await database.db.transaction((tx) =>
      intents.writeGroupAuthoredIntentInTx(tx, {
        groupId: h.groupId,
        threadId: h.threadId,
        memberUserId: pending.id,
        author: 'MEMBER',
        status: 'REQUESTED',
      }),
    );
    await groups.leaveGroup({ threadId: h.threadId, userId: pending.id });
    expect(await notices(h.threadId)).toHaveLength(0);
  });

  it('rolls a failed departure message back with membership and boundary', async () => {
    const h = await hosted();
    const spy = vi
      .spyOn(app.get(MessageService), 'writeSystemMessageInTx')
      .mockRejectedValueOnce(new Error('storage failed'));
    try {
      await expect(
        groups.leaveGroup({ threadId: h.threadId, userId: h.member.id }),
      ).rejects.toThrow('storage failed');
    } finally {
      spy.mockRestore();
    }
    expect(
      (await findGroupRelationship(database.db, h.groupId, h.member.id)).pair
        ?.active,
    ).toBe(true);
    expect(await notices(h.threadId)).toHaveLength(0);
    expect(
      (await boundary(h.threadId, h.member.id))?.messageVisibleThroughSeq,
    ).toBeNull();
  });

  it('locks the mirror peer allocator before departure messages allocate client state', async () => {
    const h = await mirror();
    const peerLocks = vi.spyOn(
      app.get(PeerStateFeedService),
      'lockTargetsInTx',
    );
    const departure = vi.spyOn(
      app.get(MessageService),
      'writeSystemMessageInTx',
    );
    try {
      await groups.leaveGroup({ threadId: h.threadId, userId: h.member.id });
      expect(departure).toHaveBeenCalledTimes(1);
      const index = peerLocks.mock.calls.findIndex(([, targets]) =>
        targets.some(
          (target) =>
            target.peerDomain === h.peerDomain &&
            target.namespaceId === h.namespaceId,
        ),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(peerLocks.mock.invocationCallOrder[index]).toBeLessThan(
        departure.mock.invocationCallOrder[0],
      );
      expect(await notices(h.threadId)).toHaveLength(1);
    } finally {
      peerLocks.mockRestore();
      departure.mockRestore();
    }
  });

  it.each(['leave', 'kick'] as const)(
    'delivers mirror %s to both local members once',
    async (path) => {
      const h = await mirror();
      const revoked = {
        ...h,
        groupAccount: h.parent.account,
        memberAccount: h.member.account,
        invite: true,
      };
      if (path === 'leave')
        await groups.leaveGroup({ threadId: h.threadId, userId: h.member.id });
      await revokePeer(revoked);
      await revokePeer(revoked);
      const rows = await notices(h.threadId);
      expect(rows).toHaveLength(1);
      await assertHeads(h.threadId, [h.member.id, h.observer.id], rows[0].seq);
      expect(
        (await boundary(h.threadId, h.member.id))?.messageVisibleThroughSeq,
      ).toBe(rows[0].seq);
      expect(
        (await boundary(h.threadId, h.observer.id))?.messageVisibleThroughSeq,
      ).toBeNull();
    },
  );

  it('generates a hosted departure for an incoming remote member revocation only once', async () => {
    const h = await hosted();
    const peerDomain = 'departure-remote.test';
    const namespaceId = await seedFederatedPeerNamespace(
      database.db,
      peerDomain,
    );
    const remote = {
      account: `remote-${++serial}`,
      domain: peerDomain,
      namespaceId,
    };
    await activate(h.groupId, h.threadId, remote, true);
    const parent = await readGroupState(database.db, eq(group.id, h.groupId));
    const target = {
      peerDomain,
      namespaceId,
      memberAccount: remote.account,
      groupAccount: parent!.account,
      invite: false,
    };
    await revokePeer(target);
    await revokePeer(target);
    expect(await notices(h.threadId)).toHaveLength(1);
    await assertHeads(
      h.threadId,
      [h.owner.id, h.member.id],
      (await notices(h.threadId))[0].seq,
    );
  });

  it('emits foreign roster departures at delta commit, but not for replay or a local member already handled by intents', async () => {
    const h = await mirror();
    const taskPayload = {
      groupId: h.groupId,
      groupAccount: h.parent.account,
      peerDomain: h.peerDomain,
      namespaceId: h.namespaceId,
      through: '7',
    };
    await database.db.insert(groupMetaMemberFeed).values([
      {
        threadId: h.groupId,
        memberAccount: h.sourceMembers[3].account,
        memberDomain: h.sourceMembers[3].domain,
        memberNamespaceId: h.sourceMembers[3].namespaceId,
        feedId: 6n,
        operation: 'DEPART',
        body: {},
      },
      {
        threadId: h.groupId,
        memberAccount: h.sourceMembers[1].account,
        memberDomain: h.sourceMembers[1].domain,
        memberNamespaceId: h.sourceMembers[1].namespaceId,
        feedId: 7n,
        operation: 'DEPART',
        body: {},
      },
    ]);
    const run = async () => {
      const now = new Date();
      const [task] = await database.db
        .insert(durableTask)
        .values({
          kind: 'PROJECTION',
          scopeType: 'GROUP',
          scopeKey: `notice-${++serial}`,
          taskType: 'SYNC_GROUP_META',
          status: 'ASYNC_PROCESSING',
          createdAt: now,
          startedAt: now,
          payload: taskPayload,
          checkpoint: { phase: 'FINALIZE', mode: 'delta', through: '7' },
        })
        .returning();
      return app.get(GroupMetaSyncTaskExecutionService).execute(task);
    };
    await run();
    await run();
    const rows = await notices(h.threadId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).member.account).toBe(
      h.sourceMembers[3].account,
    );
    await assertHeads(h.threadId, [h.member.id, h.observer.id], rows[0].seq);
  });

  it('treats a full mirror roster as a baseline without join notifications', async () => {
    const h = await mirror();
    const [task] = await database.db
      .insert(durableTask)
      .values({
        kind: 'PROJECTION',
        scopeType: 'GROUP',
        scopeKey: `baseline-${++serial}`,
        taskType: 'SYNC_GROUP_META',
        status: 'ASYNC_PROCESSING',
        createdAt: sql`now()`,
        startedAt: sql`now()`,
        payload: {
          groupId: h.groupId,
          groupAccount: h.parent.account,
          peerDomain: h.peerDomain,
          namespaceId: h.namespaceId,
          through: '5',
        },
        checkpoint: { phase: 'FINALIZE', mode: 'full', through: '5' },
      })
      .returning();
    await database.db
      .update(groupMetaProfileFeed)
      .set({ fullSyncRunId: task.id })
      .where(eq(groupMetaProfileFeed.threadId, h.groupId));
    await database.db
      .delete(groupMetaFeed)
      .where(eq(groupMetaFeed.threadId, h.groupId));
    await app.get(GroupMetaSyncTaskExecutionService).execute(task);
    expect(await notices(h.threadId, 'GROUP_JOINED')).toHaveLength(0);
    expect(
      await database.db.query.durableTask.findFirst({
        where: and(
          eq(
            durableTask.scopeKey,
            JSON.stringify(['THREAD_FANOUT', h.threadId]),
          ),
          eq(durableTask.taskType, DurableTaskType.FAN_OUT_THREAD_CONTENT),
        ),
      }),
    ).toBeUndefined();
  });

  it('commits mirror joins with local fanout, ignores profile updates, and rolls back failed admission', async () => {
    const h = await mirror();
    const newcomer = await identity();
    await activate(h.groupId, h.threadId, newcomer.id, false);
    const remote = {
      account: `joined-${++serial}`,
      domain: h.peerDomain,
      namespaceId: h.namespaceId,
    };
    const facts = [
      { member: h.sourceMembers[3], operation: 'UPSERT' as const },
      {
        member: { account: newcomer.account, domain: 'local', namespaceId: 0 },
        operation: 'UPSERT' as const,
      },
      { member: remote, operation: 'UPSERT' as const },
      { member: remote, operation: 'DEPART' as const },
      { member: remote, operation: 'UPSERT' as const },
    ];
    await database.db.insert(groupMetaMemberFeed).values(
      facts.map(({ member, operation }, index) => ({
        threadId: h.groupId,
        feedId: BigInt(6 + index),
        memberAccount: member.account,
        memberDomain: member.domain,
        memberNamespaceId: member.namespaceId,
        operation,
        body: operation === 'UPSERT' ? { role: 'MEMBER', profileRev: 2 } : {},
      })),
    );
    const [task] = await database.db
      .insert(durableTask)
      .values({
        kind: 'PROJECTION',
        scopeType: 'GROUP',
        scopeKey: `join-${++serial}`,
        taskType: 'SYNC_GROUP_META',
        status: 'ASYNC_PROCESSING',
        createdAt: sql`now()`,
        startedAt: sql`now()`,
        payload: {
          groupId: h.groupId,
          groupAccount: h.parent.account,
          peerDomain: h.peerDomain,
          namespaceId: h.namespaceId,
          through: '10',
        },
        checkpoint: { phase: 'FINALIZE', mode: 'delta', through: '10' },
      })
      .returning();
    const service = app.get(GroupMetaSyncTaskExecutionService);
    const writer = app.get(MessageService);
    const write = writer.writeSystemMessageInTx.bind(writer);
    const failure = vi
      .spyOn(writer, 'writeSystemMessageInTx')
      .mockImplementationOnce(async (...args) => {
        await write(...args);
        throw new Error('after fanout admission');
      });
    try {
      await expect(service.execute(task)).rejects.toThrow(
        'after fanout admission',
      );
    } finally {
      failure.mockRestore();
    }
    expect(await notices(h.threadId, 'GROUP_JOINED')).toHaveLength(0);
    expect(
      (
        await database.db.query.groupMetaFeed.findFirst({
          where: eq(groupMetaFeed.threadId, h.groupId),
        })
      )?.feedEndId,
    ).toBe(5n);
    expect(
      await database.db.query.durableTask.findFirst({
        where: and(
          eq(
            durableTask.scopeKey,
            JSON.stringify(['THREAD_FANOUT', h.threadId]),
          ),
          eq(durableTask.taskType, DurableTaskType.FAN_OUT_THREAD_CONTENT),
        ),
      }),
    ).toBeUndefined();
    await service.execute(task);
    const joined = await notices(h.threadId, 'GROUP_JOINED');
    expect(joined.map((row) => JSON.parse(row.content).member.account)).toEqual(
      [newcomer.account, remote.account, remote.account],
    );
    expect(await notices(h.threadId)).toHaveLength(1);
    await assertHeads(
      h.threadId,
      [h.member.id, h.observer.id, newcomer.id],
      joined[2].seq,
    );
    // A second task at the same committed coordinate cannot repeat notifications.
    const [replay] = await database.db
      .insert(durableTask)
      .values({
        kind: task.kind,
        scopeType: task.scopeType,
        scopeKey: `join-${++serial}`,
        taskType: task.taskType,
        status: 'ASYNC_PROCESSING',
        createdAt: sql`now()`,
        startedAt: sql`now()`,
        payload: task.payload,
        checkpoint: task.checkpoint,
      })
      .returning();
    await service.execute(replay);
    expect(await notices(h.threadId, 'GROUP_JOINED')).toHaveLength(3);
  });

  it.each(['local', 'remote', 'denied'] as const)(
    'generates one FRIEND_REMOVED boundary through the %s entry',
    async (path) => {
      const local = await identity();
      const peerDomain = 'departure-remote.test';
      const peer =
        path === 'local'
          ? await identity()
          : {
              account: `remote-friend-${++serial}`,
              domain: peerDomain,
              namespaceId: await seedFederatedPeerNamespace(
                database.db,
                peerDomain,
              ),
            };
      const peerTarget: AccountTarget = 'id' in peer ? peer.id : peer;
      await database.db.transaction(async (tx) => {
        await relationships.writeLocalP2PIntentInTx(
          tx,
          local.id,
          peerTarget,
          true,
        );
        if (path === 'local') {
          await relationships.writeLocalP2PIntentInTx(
            tx,
            peerTarget as number,
            local.id,
            true,
          );
        } else {
          await relationships.applyRemoteP2PIntentInTx(tx, {
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            localUserId: local.id,
            peerUserId: peerTarget,
            status: 'ACCEPTED',
            profileRev: 0,
            note: '',
            requestedAt: new Date(),
            expiresAt: null,
            origin: peerDomain,
          });
        }
      });
      const threadId = (
        await findP2PRelationship(database.db, local.id, peerTarget)
      ).pair!.threadId!;
      const run = async () => {
        if (path === 'denied') {
          const state = await database.db.query.messageThread.findFirst({
            where: eq(messageThread.id, threadId),
          });
          const namespaceId =
            typeof peerTarget === 'number' ? 0 : peerTarget.namespaceId;
          const outcome = await app
            .get(FederationThreadQueryDenialService)
            .handleThreadQueryForbidden(
              threadId,
              peerDomain,
              namespaceId,
              state!.authorizationEpoch,
            );
          if (outcome === 'P2P_REVOKE_QUEUED') {
            const pending = await database.db.query.durableTask.findFirst({
              where: and(
                eq(
                  durableTask.taskType,
                  DurableTaskType.REVOKE_USER_RELATIONSHIP,
                ),
                sql`${durableTask.payload}->>'threadId' = ${String(threadId)}`,
                eq(durableTask.status, 'PENDING'),
              ),
            });
            expect(pending?.payload.threadId).toBe(threadId);
            expect(pending?.payload.intentAuthorUserId).toBe(local.id);
            const store = app.get(DurableTaskStoreService);
            const claimed = await store.claim(pending!.id);
            await app.get(RevokeUserRelationshipTaskHandler).execute(claimed!);
            await store.markSucceeded(pending!.id);
          }
          return outcome;
        }
        return path === 'local'
          ? app.get(AccountThreadStateService).endP2P(threadId, local.id)
          : database.db.transaction((tx) =>
              relationships.applyRemoteP2PIntentInTx(tx, {
                messageEndSeq: 0,
                tombstoneEndSeq: 0,
                localUserId: local.id,
                peerUserId: peerTarget,
                status: 'REVOKED',
                profileRev: 0,
                note: '',
                requestedAt: null,
                expiresAt: null,
                origin: 'departure-remote.test',
              }),
            );
      };
      await run();
      await run();
      const rows = await notices(threadId, 'FRIEND_REMOVED');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        creatorAccount: '$system',
        creatorDomain: 'local',
        creatorNamespaceId: 0,
        profileRev: 0,
      });
      expect(JSON.parse(rows[0].content)).toEqual(
        path === 'denied'
          ? {
              type: 'FRIEND_REMOVED',
              initiator: { account: '$system', domain: 'local' },
            }
          : {
              type: 'FRIEND_REMOVED',
              initiator:
                path === 'local'
                  ? { account: local.account, domain: 'local' }
                  : { account: peer.account, domain: peerDomain },
            },
      );
      for (const id of typeof peerTarget === 'number'
        ? [local.id, peerTarget]
        : [local.id])
        expect((await boundary(threadId, id))?.messageVisibleThroughSeq).toBe(
          rows[0].seq,
        );
    },
  );
  it.each(['hosted', 'mirror'] as const)(
    'closes denied %s group directions without remote account rows',
    async (path) => {
      const h = path === 'hosted' ? await hosted() : await mirror();
      const peerDomain =
        'peerDomain' in h ? h.peerDomain : 'departure-denied.test';
      const namespaceId = await seedFederatedPeerNamespace(
        database.db,
        peerDomain,
      );
      const remote = {
        account: `denied-member-${++serial}`,
        domain: peerDomain,
        namespaceId,
      };
      if (path === 'hosted')
        await activate(h.groupId, h.threadId, remote, true);
      expect(
        await app
          .get(FederationThreadSourceService)
          .resolve(h.threadId, peerDomain, namespaceId),
      ).toMatchObject({
        kind: 'GROUP',
        localGroupAuthority: path === 'hosted',
      });
      const state = await database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, h.threadId),
      });
      expect(
        await app
          .get(FederationThreadQueryDenialService)
          .handleThreadQueryForbidden(
            h.threadId,
            peerDomain,
            namespaceId,
            state!.authorizationEpoch,
          ),
      ).toBe('GROUP_REVOKE_QUEUED');
      const admitted = await database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, h.threadId),
      });
      expect(admitted!.authorizationEpoch).toBe(
        state!.authorizationEpoch + (path === 'mirror' ? 1 : 0),
      );
      expect(admitted!.federationRoundsEnabled).toBe(path === 'hosted');
      const parent = await database.db.query.durableTask.findFirst({
        where: and(
          eq(durableTask.taskType, DurableTaskType.REVOKE_FORBIDDEN_GROUP),
          eq(durableTask.status, 'PENDING'),
        ),
      });
      expect(parent?.coalescingKey).toBeNull();
      const store = app.get(DurableTaskStoreService);
      const claimed = await store.claim(parent!.id);
      expect(
        await app
          .get(GroupRevokeFanoutService)
          .insertNextMember(claimed!, h.threadId),
      ).toBe(true);
      const interrupted = await database.db.query.durableTask.findFirst({
        where: eq(durableTask.id, parent!.id),
      });
      expect(
        BigInt(interrupted!.checkpoint.afterPairId as string),
      ).toBeGreaterThan(0n);
      // Re-enter using the original task snapshot: progress must be read from PostgreSQL.
      await app.get(RevokeForbiddenGroupTaskHandler).execute(claimed!);
      await store.markSucceeded(parent!.id);
      const children = await database.db
        .select()
        .from(durableTask)
        .where(
          and(
            eq(durableTask.taskType, DurableTaskType.FORCE_REVOKE_GROUP_MEMBER),
            eq(durableTask.scopeKey, parent!.scopeKey),
            eq(durableTask.status, 'PENDING'),
          ),
        );
      expect(children).toHaveLength(path === 'mirror' ? 2 : 1);
      for (const child of children) {
        expect(child.payload.direction).toBe(
          path === 'mirror' ? 'MEMBER' : 'GROUP',
        );
        const running = await store.claim(child.id);
        await app.get(ForceRevokeGroupMemberTaskHandler).execute(running!);
        await store.markSucceeded(child.id);
      }
      const targets = 'observer' in h ? [h.member.id, h.observer.id] : [remote];
      for (const target of targets)
        expect(
          (await findGroupRelationship(database.db, h.groupId, target)).pair
            ?.active,
        ).toBe(false);
      await expect(
        app
          .get(FederationThreadSourceService)
          .resolve(h.threadId, peerDomain, namespaceId),
      ).rejects.toThrow(FederationThreadSourceInactiveError);
    },
  );
});
