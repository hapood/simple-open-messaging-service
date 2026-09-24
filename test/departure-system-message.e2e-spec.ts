import { ReceivedUserIntentService } from '../src/user/p2p-intent/received/received-user-intent.service.js';
import { UserIntentService } from '../src/user/p2p-intent/authored/user-intent.service.js';
import { FederationThreadQueryDenialService } from '../src/federation/federation-thread-query-denial.service.js';
import { FederationThreadSourceInactiveError } from '../src/federation/federation-errors.js';
import { RevokeForbiddenGroupTaskHandler } from '../src/group/revoke-forbidden-group-task.handler.js';
import { DisbandGroupTaskHandler } from '../src/group/disband-group-task.handler.js';
import { ForceRevokeGroupMemberTaskHandler } from '../src/group/force-revoke-group-member-task.handler.js';
import { GroupRevokeFanoutService } from '../src/group/group-revoke-fanout.service.js';
import { DurableTaskQueueService } from '../src/durable-task/durable-task-queue.service.js';
import { FederationThreadSourceService } from '../src/federation/federation-thread-source.service.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import {
  groupState as group,
  readGroupState,
} from '../src/group/shared/group-state.js';
import type { AccountTarget } from '../src/user/account-address.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq, and, asc, sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  groupMeta,
  groupMetaMemberFeed,
  messageThread,
  message,
  accountThreadState,
  durableTask,
} from '../src/database/schema.js';
import { GroupService } from '../src/group/group.service.js';
import { MessageService } from '../src/message/message.service.js';
import { ClientStateFeedService } from '../src/client-state-feed/client-state-feed.service.js';
import { applyDeltaMirrorMetaItemInTx } from '../src/group/meta/apply-delta-mirror-meta-item-in-tx.js';
import { ThreadFanoutTaskHandler } from '../src/message/thread-fanout-task.handler.js';
import { ThreadFanoutProgressService } from '../src/message/thread-fanout-progress.service.js';
import { parseAccountThreadFanoutTarget } from '../src/message/account-thread-fanout-task.js';
import { DurableTaskStoreService } from '../src/durable-task/durable-task-store.service.js';
import { DurableTaskType } from '../src/durable-task/durable-task.constants.js';
import { RelationshipIntentService } from '../src/relationship/relationship-intent.service.js';
import { AccountThreadStateService } from '../src/account-thread-state/account-thread-state.service.js';
import { GroupAuthoredMembershipIntentService } from '../src/group/membership-intent/authored/group-authored-membership-intent.service.js';
import { MemberAuthoredGroupMembershipIntentService } from '../src/group/membership-intent/authored/member-authored-group-membership-intent.service.js';
import { GroupRelationshipFoldService } from '../src/group/membership-intent/shared/group-relationship-fold.service.js';
import { FederationStateFeedConsumerService } from '../src/federation/federation-state-feed-consumer.service.js';
import { mintGroupAccount } from '../src/common/account.js';
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
  let groupIntents: GroupAuthoredMembershipIntentService;
  let memberIntents: MemberAuthoredGroupMembershipIntentService;
  let intents: RelationshipIntentService;
  let memberships: GroupRelationshipFoldService;
  let consumer: FederationStateFeedConsumerService;
  let serial = 0;
  beforeAll(async () => {
    // Real services and PostgreSQL, without starting background task dispatch or network listeners.
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = app.get(DatabaseService);
    groups = app.get(GroupService);
    groupIntents = app.get(GroupAuthoredMembershipIntentService);
    memberIntents = app.get(MemberAuthoredGroupMembershipIntentService);
    intents = app.get(RelationshipIntentService);
    memberships = app.get(GroupRelationshipFoldService);
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
        feedId: index + 2,
        memberAccount: row.account,
        memberDomain: row.domain,
        operation: 'MEMBER_UPSERT' as const,
        body: { role: index === 0 ? 'OWNER' : 'MEMBER', profileRev: 1 },
      })),
    );
    await database.db.insert(groupMeta).values({
      threadId: parent.id,
      metaEndId: 5,
      metaTargetId: 6,
      metaProcessedThroughId: 5,
    });
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
    return effect;
  }

  it.each(['leave', 'kick'] as const)(
    'writes one boundary for local %s and none for replay',
    async (path) => {
      const h = await hosted();
      const run = () =>
        path === 'kick'
          ? groupIntents.execute({
              threadId: h.threadId,
              managerUserId: h.owner.id,
              decision: 'REVOKED',
              scope: 'MEMBER',
              target: { account: h.member.account, domain: 'local' },
            })
          : memberIntents.execute({
              threadId: h.threadId,
              memberUserId: h.member.id,
              decision: 'REVOKED',
            });
      await run();
      await run();
      const rows = await notices(h.threadId);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].content).member.account).toBe(h.member.account);
      expect(
        (await boundary(h.threadId, h.member.id))?.messageVisibleThroughSeq,
      ).toBe(rows[0].seq);
      await assertHeads(h.threadId, [h.owner.id, h.member.id], rows[0].seq);
      expect(
        (await findGroupRelationship(database.db, h.groupId, h.member.id)).pair
          ?.active,
      ).toBe(false);
    },
  );

  it('dissolves once: one GROUP_DISSOLVED boundary for everyone, silent sweeps, coalesced re-requests', async () => {
    const h = await hosted();
    const queue = app.get(DurableTaskQueueService);
    const store = app.get(DurableTaskStoreService);
    const disbandHandler = app.get(DisbandGroupTaskHandler);
    const childHandler = app.get(ForceRevokeGroupMemberTaskHandler);
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, h.threadId),
    });
    const request = () =>
      queue.enqueueTask({
        scope: {
          type: 'GROUP',
          address: {
            account: thread!.groupAccount!,
            domain: thread!.groupDomain!,
          },
        },
        taskType: DurableTaskType.DISBAND_GROUP,
        actorUserId: h.owner.id,
        payload: { threadId: h.threadId },
      });
    const drainChildren = async (scopeKey: string) => {
      for (;;) {
        const child = await database.db.query.durableTask.findFirst({
          where: and(
            eq(durableTask.taskType, DurableTaskType.FORCE_REVOKE_GROUP_MEMBER),
            eq(durableTask.status, 'PENDING'),
            eq(durableTask.scopeKey, scopeKey),
          ),
        });
        if (!child) break;
        await childHandler.execute((await store.claim(child.id))!);
        await store.markSucceeded(child.id);
      }
    };
    const first = await request();
    expect((await request()).taskId).toBe(first.taskId);
    const parent = await store.claim(first.taskId);
    await disbandHandler.execute(parent!);
    await store.markSucceeded(first.taskId);
    // Execute the generic fanout after the child revocations. It now sees no
    // active members; the parent sweep's per-account tasks must carry the
    // dissolved boundary to each departed member independently.
    const dissolveSeq = (await notices(h.threadId, 'GROUP_DISSOLVED'))[0].seq;
    await drainChildren(parent!.scopeKey);
    await assertHeads(h.threadId, [h.owner.id, h.member.id], dissolveSeq);
    for (const id of [h.owner.id, h.member.id]) {
      const accountFanout = await database.db.query.durableTask.findFirst({
        where: and(
          eq(
            durableTask.scopeKey,
            JSON.stringify(['ACCOUNT_THREAD_FANOUT', h.threadId, id]),
          ),
          eq(
            durableTask.taskType,
            DurableTaskType.FAN_OUT_ACCOUNT_THREAD_CONTENT,
          ),
          eq(durableTask.status, 'PENDING'),
        ),
      });
      expect(accountFanout?.payload).toMatchObject({
        threadId: h.threadId,
        accountId: id,
        messageEndSeq: dissolveSeq,
      });
      const running = await store.claim(accountFanout!.id);
      expect(
        await app
          .get(ThreadFanoutProgressService)
          .projectAccount(
            running!.id,
            parseAccountThreadFanoutTarget(running!.payload),
          ),
      ).toHaveLength(1);
      await store.markSucceeded(accountFanout!.id);
      expect((await boundary(h.threadId, id))?.messageEndSeq).toBe(dissolveSeq);
    }
    expect(await notices(h.threadId, 'GROUP_LEFT')).toHaveLength(0);
    for (const id of [h.owner.id, h.member.id]) {
      expect(
        (await findGroupRelationship(database.db, h.groupId, id)).pair?.active,
      ).toBe(false);
      expect((await boundary(h.threadId, id))!.messageVisibleThroughSeq).toBe(
        dissolveSeq,
      );
    }
    const audience = await database.db.execute(
      sql`SELECT id FROM "ThreadAudience" WHERE "threadId" = ${h.threadId}`,
    );
    expect(audience.rows).toHaveLength(0);
    // A re-request after the terminal fact starts a fresh parent; the sweep
    // and its children replay as no-ops without touching message state.
    const replay = await request();
    expect(replay.taskId).not.toBe(first.taskId);
    const replayParent = await store.claim(replay.taskId);
    await disbandHandler.execute(replayParent!);
    await store.markSucceeded(replay.taskId);
    await drainChildren(replayParent!.scopeKey);
    expect(await notices(h.threadId, 'GROUP_DISSOLVED')).toHaveLength(1);
    expect(await notices(h.threadId, 'GROUP_LEFT')).toHaveLength(0);
    expect(
      (await boundary(h.threadId, h.member.id))!.messageVisibleThroughSeq,
    ).toBe(dissolveSeq);
  });

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
    await memberIntents.execute({
      threadId: h.threadId,
      memberUserId: pending.id,
      decision: 'REVOKED',
    });
    expect(await notices(h.threadId)).toHaveLength(0);
  });

  it('rolls a failed departure back with membership, message, and boundary', async () => {
    const h = await hosted();
    // The departure commits as one composed statement, so a late storage
    // failure is injected at the transaction boundary: every effect —
    // membership, the GROUP_LEFT message, and the read boundary — must
    // roll back together.
    const transaction = database.db.transaction.bind(database.db);
    const failing = vi.spyOn(database.db, 'transaction').mockImplementation(((
      run: unknown,
      config: unknown,
    ) =>
      transaction(async (tx: never) => {
        await (run as (tx: never) => Promise<unknown>)(tx);
        throw new Error('storage failed');
      }, config)) as never);
    try {
      await expect(
        memberIntents.execute({
          threadId: h.threadId,
          memberUserId: h.member.id,
          decision: 'REVOKED',
        }),
      ).rejects.toThrow('storage failed');
    } finally {
      failing.mockRestore();
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

  it('locks the mirror peer allocator during a mirror departure', async () => {
    const h = await mirror();
    const peerLocks = vi.spyOn(
      app.get(PeerStateFeedService),
      'lockOutboundStateFeedNamespacesInTx',
    );
    try {
      await memberIntents.execute({
        threadId: h.threadId,
        memberUserId: h.member.id,
        decision: 'REVOKED',
      });
      // The composed departure allocates client state inside one statement;
      // the observable contract is that the mirror namespace's outbound
      // allocator lock is part of that transaction.
      expect(
        peerLocks.mock.calls.some(([, targets]) =>
          targets.some(
            (target) =>
              target.peerDomain === h.peerDomain &&
              target.namespaceId === h.namespaceId,
          ),
        ),
      ).toBe(true);
    } finally {
      peerLocks.mockRestore();
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
      if (path === 'leave') {
        const result = await memberIntents.execute({
          threadId: h.threadId,
          memberUserId: h.member.id,
          decision: 'REVOKED',
        });
        expect(result).toMatchObject({ status: 'APPLIED' });
      }
      await revokePeer(revoked);
      await revokePeer(revoked);
      // Local mirror members leave at the relationship-intent transition.
      // Group Meta is a projection and must not issue a second notice.
      const intentRows = await notices(h.threadId);
      expect(intentRows).toHaveLength(1);
      await database.db.transaction((tx) =>
        applyDeltaMirrorMetaItemInTx(tx, {
          group: {
            account: h.parent.account,
            domain: h.peerDomain,
            namespaceId: h.namespaceId,
          },
          item: {
            feedId: 6,
            operation: 'MEMBER_DEPART',
            account: h.member.account,
            domain: 'local',
          },
          through: 6,
          reachedBoundary: false,
          messages: app.get(MessageService),
          clientStateFeed: app.get(ClientStateFeedService),
        }),
      );
      const rows = await notices(h.threadId);
      expect(rows).toHaveLength(1);
      expect(rows[0].seq).toBe(intentRows[0].seq);
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
      const receivedUserIntents = app.get(ReceivedUserIntentService);
      const userIntents = app.get(UserIntentService);
      const peerIsLocal = path === 'local';
      const localToPeerTarget = peerIsLocal
        ? { account: (peer as { account: string }).account, domain: 'local' }
        : {
            account: (peer as { account: string }).account,
            domain: peerDomain,
            namespaceId: (peer as { namespaceId: number }).namespaceId,
          };
      await database.db.transaction(async (tx) => {
        await userIntents.executeInTx(
          tx,
          {
            userId: local.id,
            decision: 'REQUESTED',
            target: localToPeerTarget,
          },
          [],
        );
        if (path === 'local') {
          await userIntents.executeInTx(
            tx,
            {
              userId: peerTarget as number,
              decision: 'ACCEPTED',
              target: { account: local.account, domain: 'local' },
            },
            [],
          );
        } else {
          await receivedUserIntents.applyInTx(
            tx,
            {
              localUserId: local.id,
              peer: {
                account: peer.account,
                domain: peerDomain,
                namespaceId: (peer as { namespaceId: number }).namespaceId,
              },
              body: {
                status: 'ACCEPTED',
                profileRev: 0,
                note: '',
                requestedAt: Date.now(),
                expiresAt: null,
                messageEndSeq: 0,
                tombstoneEndSeq: 0,
              },
            },
            [],
            new Set(),
          );
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
          return outcome;
        }
        return path === 'local'
          ? userIntents.execute({
              userId: local.id,
              decision: 'REVOKED',
              target: localToPeerTarget,
            })
          : receivedUserIntents.execute({
              localUserId: local.id,
              peer: {
                account: peer.account,
                domain: peerDomain,
                namespaceId: (peer as { namespaceId: number }).namespaceId,
              },
              body: {
                status: 'REVOKED',
                profileRev: 0,
                note: '',
                requestedAt: null,
                expiresAt: null,
              },
            });
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
      const body = JSON.parse(rows[0].content);
      expect(body).toMatchObject({
        type: 'FRIEND_REMOVED',
        initiator:
          path === 'local' || path === 'denied'
            ? {
                account: local.account,
                domain: 'local',
                namespaceId: 0,
                profileRev: expect.any(Number),
              }
            : {
                account: peer.account,
                domain: peerDomain,
                namespaceId: 'namespaceId' in peer ? peer.namespaceId : 0,
                profileRev: 0,
              },
      });
      expect(body.participants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            account: local.account,
            domain: 'local',
            namespaceId: 0,
          }),
          expect.objectContaining({
            account: peer.account,
            domain: peerIsLocal ? 'local' : peerDomain,
            namespaceId: 'namespaceId' in peer ? peer.namespaceId : 0,
          }),
        ]),
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
      ).toBe(
        path === 'mirror' ? 'MIRROR_WAITING_FOR_PUSH' : 'GROUP_REVOKE_QUEUED',
      );
      const admitted = await database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, h.threadId),
      });
      expect(admitted!.authorizationEpoch).toBe(state!.authorizationEpoch);
      expect(admitted!.federationRoundsEnabled).toBe(true);
      if (path === 'mirror') {
        expect(
          await database.db.query.durableTask.findFirst({
            where: and(
              eq(durableTask.status, 'PENDING'),
              sql`${durableTask.payload} ->> 'threadId' = ${String(h.threadId)}`,
            ),
          }),
        ).toBeUndefined();
        for (const target of [h.member.id, h.observer.id])
          expect(
            (await findGroupRelationship(database.db, h.groupId, target)).pair
              ?.active,
          ).toBe(true);
        await expect(
          app
            .get(FederationThreadSourceService)
            .resolve(h.threadId, peerDomain, namespaceId),
        ).resolves.toMatchObject({ kind: 'GROUP', localGroupAuthority: false });
        return;
      }
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
      expect(children).toHaveLength(1);
      for (const child of children) {
        expect(child.payload.direction).toBe('GROUP');
        const running = await store.claim(child.id);
        await app.get(ForceRevokeGroupMemberTaskHandler).execute(running!);
        await store.markSucceeded(child.id);
      }
      for (const target of [remote])
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
