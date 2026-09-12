import { groupState as group, groupStateFields } from '../group/group-state.js';
import { MessageService } from '../message/message.service.js';
import { SystemMessageType } from '../message/system-message.js';
import {
  requireGroupThreadContentLockUnderGroupInTx,
  type ThreadContentLock,
} from '../business/shared/locks/thread-content-lock.js';
import { lockBusinessAccountsInTx } from '../business/shared/locks/account-business-lock.js';
import { readCurrentLocalAuthorizedGroupMemberIdsInTx } from '../group-meta/current-group-roster.js';
import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { ensureLocalAccountThreadStateInTx } from '../account-thread-state/local-account-thread-state.js';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../client-state-feed/client-state-feed.service.js';
import {
  isValidSomfpDomain,
  isValidSomfpUserAccount,
  normalizeAccount,
} from '../common/account.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { GroupRole } from '../database/enums.js';
import {
  durableTask,
  groupMeta,
  groupMetaMemberFeed,
  groupMetaProfileFeed,
  messageThread,
} from '../database/schema.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { saveTaskCheckpointInTx } from '../durable-task/task-checkpoint.js';
import { enqueueThreadFanoutInTx } from '../message/thread-fanout-task.js';
import {
  toClientIdentity,
  type NamespacedAddress,
} from '../common/client-identity.js';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';
import { FederationGroupMetaClient } from './federation-group-meta-client.service.js';
import { loadFederationConfig } from './federation.config.js';
import { FederationGroupRosterProjectionService } from './federation-group-roster-projection.service.js';
import type {
  GroupMetaFeedItem,
  GroupMetaFeedPage,
} from './group-meta-feed.service.js';
import {
  type GroupMetaSyncCheckpoint,
  type GroupMetaSyncTaskPayload,
  readGroupMetaSyncTask,
} from './group-meta-sync-task.js';

const CLEANUP_PAGE_SIZE = 100;

@Injectable()
export class GroupMetaSyncTaskExecutionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly client: FederationGroupMetaClient,
    private readonly groupRosterProjection: FederationGroupRosterProjectionService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly messages: MessageService,
  ) {}

  /** Refresh admission-time cursors before any asynchronous page can run.
   * A predecessor may have failed, or completed a full recovery beyond this
   * task's target. PROCESSING recovery can safely repeat this preparation. */
  async prepare(task: DurableTask): Promise<{ ready: boolean }> {
    const { payload } = readGroupMetaSyncTask(task);
    return this.database.db.transaction(async (tx) => {
      await lockBusinessAccountsInTx(tx, [
        { account: payload.groupAccount, domain: payload.peerDomain },
      ]);
      const current = await lockTaskInTx(tx, task.id, 'PROCESSING');
      requireSameTask(readGroupMetaSyncTask(current).payload, payload);
      await requireMirrorInTx(tx, payload);
      const [feed] = await tx
        .select({ metaEndId: groupMeta.metaEndId })
        .from(groupMeta)
        .where(eq(groupMeta.threadId, payload.groupId))
        .limit(1);
      if (feed && feed.metaEndId >= BigInt(payload.through)) {
        return { ready: true };
      }
      await saveTaskCheckpointInTx(
        tx,
        task.id,
        {
          phase: 'PULL',
          mode: feed ? 'delta' : 'full',
          after: (feed?.metaEndId ?? 0n).toString(),
          through: payload.through,
        },
        'PROCESSING',
      );
      return { ready: false };
    });
  }

  async execute(task: DurableTask): Promise<GroupMetaSyncCompletionEffect> {
    for (;;) {
      const current = await this.readCurrent(task.id);
      const { payload, checkpoint } = readGroupMetaSyncTask(current);
      if (checkpoint.phase === 'PULL') {
        let page: GroupMetaFeedPage;
        try {
          page = await this.client.fetchPage(payload.peerDomain, {
            account: payload.groupAccount,
            mode: checkpoint.mode,
            after: BigInt(checkpoint.after),
            through: BigInt(checkpoint.through),
          });
        } catch (error) {
          if (
            checkpoint.mode !== 'delta' ||
            !(error instanceof RemoteFeedCursorUnavailableError)
          )
            throw error;
          await this.beginFullRecovery(task.id, payload, checkpoint, error);
          continue;
        }
        await this.applyPage(task.id, payload, checkpoint, page);
        continue;
      }
      if (checkpoint.phase === 'CLEANUP_MEMBERS') {
        await this.cleanupFullMembers(task.id, payload, checkpoint);
        continue;
      }
      return this.finalize(task.id, payload, checkpoint);
    }
  }

  private async readCurrent(taskId: bigint): Promise<DurableTask> {
    const [task] = await this.database.db
      .select()
      .from(durableTask)
      .where(eq(durableTask.id, taskId))
      .limit(1);
    if (!task || task.status !== 'ASYNC_PROCESSING')
      throw new Error('async group-meta sync task is no longer active');
    return task;
  }

  private async beginFullRecovery(
    taskId: bigint,
    payload: GroupMetaSyncTaskPayload,
    checkpoint: Extract<GroupMetaSyncCheckpoint, { phase: 'PULL' }>,
    recovery: RemoteFeedCursorUnavailableError,
  ): Promise<void> {
    const through = recovery.resumeBefore - 1n;
    if (
      recovery.resumeAfter < 0n ||
      recovery.resumeBefore <= recovery.resumeAfter ||
      through < BigInt(payload.through)
    )
      throw new Error('invalid group-meta full recovery target');
    await this.database.db.transaction(async (tx) => {
      await lockBusinessAccountsInTx(tx, [
        { account: payload.groupAccount, domain: payload.peerDomain },
      ]);
      const locked = await lockTaskInTx(tx, taskId);
      const current = readGroupMetaSyncTask(locked);
      requireSamePull(current.payload, current.checkpoint, payload, checkpoint);
      await saveTaskCheckpointInTx(
        tx,
        taskId,
        {
          phase: 'PULL',
          mode: 'full',
          after: recovery.resumeAfter.toString(),
          through: through.toString(),
        },
        'ASYNC_PROCESSING',
      );
    });
  }

  private async applyPage(
    taskId: bigint,
    payload: GroupMetaSyncTaskPayload,
    checkpoint: Extract<GroupMetaSyncCheckpoint, { phase: 'PULL' }>,
    page: GroupMetaFeedPage,
  ): Promise<void> {
    const sourceEnd = BigInt(page.groupMetaFeedEndId);
    const scannedThrough = BigInt(page.scannedThrough);
    const through = BigInt(checkpoint.through);
    if (sourceEnd < through || (!page.hasMore && scannedThrough !== through))
      throw new Error('group-meta page did not reach its fixed target');
    const items = page.items.map((item) => validateItem(item, checkpoint.mode));
    await this.database.db.transaction(async (tx) => {
      await lockBusinessAccountsInTx(tx, [
        { account: payload.groupAccount, domain: payload.peerDomain },
      ]);
      const locked = await lockTaskInTx(tx, taskId);
      const current = readGroupMetaSyncTask(locked);
      requireSamePull(current.payload, current.checkpoint, payload, checkpoint);
      await requireMirrorInTx(tx, payload);
      for (const item of items)
        await this.applyItemInTx(tx, taskId, payload, checkpoint.mode, item);
      const nextCheckpoint: GroupMetaSyncCheckpoint = page.hasMore
        ? {
            phase: 'PULL',
            mode: checkpoint.mode,
            after: page.scannedThrough,
            through: checkpoint.through,
          }
        : checkpoint.mode === 'full'
          ? {
              phase: 'CLEANUP_MEMBERS',
              mode: 'full',
              through: checkpoint.through,
            }
          : {
              phase: 'FINALIZE',
              mode: 'delta',
              through: checkpoint.through,
            };
      await saveTaskCheckpointInTx(
        tx,
        taskId,
        nextCheckpoint,
        'ASYNC_PROCESSING',
      );
    });
  }

  private async applyItemInTx(
    tx: DatabaseTransaction,
    taskId: bigint,
    payload: GroupMetaSyncTaskPayload,
    mode: 'full' | 'delta',
    item: ValidGroupMetaItem,
  ): Promise<void> {
    if (item.operation === 'GROUP_PROFILE') {
      const [existing] = await tx
        .select({
          feedId: groupMetaProfileFeed.feedId,
          profileRev: groupMetaProfileFeed.profileRev,
          fullSyncRunId: groupMetaProfileFeed.fullSyncRunId,
        })
        .from(groupMetaProfileFeed)
        .where(eq(groupMetaProfileFeed.threadId, payload.groupId))
        .limit(1);
      if (existing?.fullSyncRunId === taskId && existing.feedId !== item.feedId)
        throw new Error('full group-meta returned more than one profile item');
      if (existing?.feedId === item.feedId) {
        if (existing.profileRev !== item.profileRev)
          throw new Error('conflicting group-meta profile coordinate');
        if (mode === 'full')
          await tx
            .update(groupMetaProfileFeed)
            .set({ fullSyncRunId: taskId, updatedAt: new Date() })
            .where(eq(groupMetaProfileFeed.threadId, payload.groupId));
        return;
      }
      await tx
        .insert(groupMetaProfileFeed)
        .values({
          threadId: payload.groupId,
          feedId: item.feedId,
          profileRev: item.profileRev,
          fullSyncRunId: mode === 'full' ? taskId : null,
        })
        .onConflictDoUpdate({
          target: groupMetaProfileFeed.threadId,
          set: {
            feedId: item.feedId,
            profileRev: item.profileRev,
            fullSyncRunId: mode === 'full' ? taskId : null,
            updatedAt: new Date(),
          },
        });
      return;
    }

    const member = toClientIdentity(
      {
        account: item.account,
        domain: item.domain,
        namespaceId: payload.namespaceId,
      },
      loadFederationConfig().domain,
    );
    if (mode === 'full') {
      const duplicate = await tx
        .select({ feedId: groupMetaMemberFeed.feedId })
        .from(groupMetaMemberFeed)
        .where(
          and(
            eq(groupMetaMemberFeed.threadId, payload.groupId),
            eq(groupMetaMemberFeed.memberAccount, member.account),
            eq(groupMetaMemberFeed.memberDomain, member.domain),
            eq(groupMetaMemberFeed.memberNamespaceId, member.namespaceId),
            eq(groupMetaMemberFeed.fullSyncRunId, taskId),
            ne(groupMetaMemberFeed.feedId, item.feedId),
          ),
        )
        .limit(1);
      if (duplicate.length > 0)
        throw new Error('full group-meta returned a duplicate member');
    }
    const [existing] = await tx
      .select({
        account: groupMetaMemberFeed.memberAccount,
        domain: groupMetaMemberFeed.memberDomain,
        namespaceId: groupMetaMemberFeed.memberNamespaceId,
        operation: groupMetaMemberFeed.operation,
        body: groupMetaMemberFeed.body,
      })
      .from(groupMetaMemberFeed)
      .where(
        and(
          eq(groupMetaMemberFeed.threadId, payload.groupId),
          eq(groupMetaMemberFeed.feedId, item.feedId),
        ),
      )
      .limit(1);
    const body =
      item.operation === 'UPSERT'
        ? { role: item.role, profileRev: item.profileRev }
        : {};
    if (existing) {
      if (
        existing.account !== member.account ||
        existing.domain !== member.domain ||
        existing.namespaceId !== member.namespaceId ||
        existing.operation !== item.operation ||
        !isDeepStrictEqual(existing.body, body)
      )
        throw new Error('conflicting group-meta member coordinate');
      if (mode === 'full')
        await tx
          .update(groupMetaMemberFeed)
          .set({ fullSyncRunId: taskId, updatedAt: new Date() })
          .where(
            and(
              eq(groupMetaMemberFeed.threadId, payload.groupId),
              eq(groupMetaMemberFeed.feedId, item.feedId),
            ),
          );
      return;
    }
    await tx.insert(groupMetaMemberFeed).values({
      threadId: payload.groupId,
      feedId: item.feedId,
      memberAccount: member.account,
      memberDomain: member.domain,
      memberNamespaceId: member.namespaceId,
      operation: item.operation,
      body,
      fullSyncRunId: mode === 'full' ? taskId : null,
    });
  }

  private async cleanupFullMembers(
    taskId: bigint,
    payload: GroupMetaSyncTaskPayload,
    checkpoint: Extract<GroupMetaSyncCheckpoint, { phase: 'CLEANUP_MEMBERS' }>,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await lockBusinessAccountsInTx(tx, [
        { account: payload.groupAccount, domain: payload.peerDomain },
      ]);
      const locked = await lockTaskInTx(tx, taskId);
      const current = readGroupMetaSyncTask(locked);
      requireSameTask(current.payload, payload);
      if (!isDeepStrictEqual(current.checkpoint, checkpoint))
        throw new Error('group-meta cleanup checkpoint changed');
      await requireMirrorInTx(tx, payload);
      const stale = await tx
        .select({ feedId: groupMetaMemberFeed.feedId })
        .from(groupMetaMemberFeed)
        .where(
          and(
            eq(groupMetaMemberFeed.threadId, payload.groupId),
            sql`${groupMetaMemberFeed.fullSyncRunId} IS DISTINCT FROM ${taskId}`,
          ),
        )
        .orderBy(groupMetaMemberFeed.feedId)
        .limit(CLEANUP_PAGE_SIZE);
      if (stale.length > 0)
        await tx.delete(groupMetaMemberFeed).where(
          and(
            eq(groupMetaMemberFeed.threadId, payload.groupId),
            inArray(
              groupMetaMemberFeed.feedId,
              stale.map((row) => row.feedId),
            ),
          ),
        );
      if (stale.length < CLEANUP_PAGE_SIZE)
        await saveTaskCheckpointInTx(
          tx,
          taskId,
          {
            phase: 'FINALIZE',
            mode: 'full',
            through: checkpoint.through,
          },
          'ASYNC_PROCESSING',
        );
    });
  }

  private async finalize(
    taskId: bigint,
    payload: GroupMetaSyncTaskPayload,
    checkpoint: Extract<GroupMetaSyncCheckpoint, { phase: 'FINALIZE' }>,
  ): Promise<GroupMetaSyncCompletionEffect> {
    return this.database.db.transaction(async (tx) => {
      await lockBusinessAccountsInTx(tx, [
        { account: payload.groupAccount, domain: payload.peerDomain },
      ]);
      const locked = await lockTaskInTx(tx, taskId);
      const current = readGroupMetaSyncTask(locked);
      requireSameTask(current.payload, payload);
      if (!isDeepStrictEqual(current.checkpoint, checkpoint))
        throw new Error('group-meta final checkpoint changed');
      await requireMirrorInTx(tx, payload);
      const [thread] = await tx
        .select({
          id: messageThread.id,
          tombstoneEndSeq: messageThread.tombstoneEndSeq,
        })
        .from(messageThread)
        .where(eq(messageThread.id, payload.groupId))
        .limit(1);
      if (!thread) throw new Error('group-meta mirror thread is missing');
      const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
        tx,
        payload.groupId,
        thread.id,
      );
      const roster = await tx.execute<{ role: GroupRole }>(sql`
        SELECT latest.body ->> 'role' AS role
        FROM (
          SELECT DISTINCT ON (member_fact."memberDomain", member_fact."memberAccount")
            member_fact.operation, member_fact.body
          FROM "GroupMetaMemberFeed" member_fact
          WHERE member_fact."threadId" = ${payload.groupId}
          ORDER BY member_fact."memberDomain", member_fact."memberAccount",
                   member_fact."feedId" DESC
        ) latest
        WHERE latest.operation = 'UPSERT'
      `);
      const ownerCount = roster.rows.filter(
        (member) => member.role === GroupRole.OWNER,
      ).length;
      if (roster.rows.length > 0 && ownerCount !== 1)
        throw new Error('group-meta roster must have exactly one owner');
      const [profile] = await tx
        .select({
          profileRev: groupMetaProfileFeed.profileRev,
          fullSyncRunId: groupMetaProfileFeed.fullSyncRunId,
        })
        .from(groupMetaProfileFeed)
        .where(eq(groupMetaProfileFeed.threadId, payload.groupId))
        .limit(1);
      if (!profile) throw new Error('group-meta mirror has no profile item');
      if (checkpoint.mode === 'full' && profile.fullSyncRunId !== taskId)
        throw new Error('full group-meta mirror has no current profile item');
      const through = BigInt(checkpoint.through);
      const [feed] = await tx
        .select({ metaEndId: groupMeta.metaEndId })
        .from(groupMeta)
        .where(eq(groupMeta.threadId, payload.groupId))
        .limit(1);
      if (feed && feed.metaEndId > through)
        throw new Error('group-meta mirror cursor moved beyond task target');
      // Full snapshots establish a baseline; only a committed delta can prove an observed membership transition.
      let transitions = 0;
      if (checkpoint.mode === 'delta' && feed && feed.metaEndId < through)
        transitions = await this.writeObservedMembershipTransitionsInTx(
          tx,
          payload,
          thread.id,
          threadLock,
          feed.metaEndId,
          through,
        );
      await tx
        .insert(groupMeta)
        .values({ threadId: payload.groupId, metaEndId: through })
        .onConflictDoUpdate({
          target: groupMeta.threadId,
          set: { metaEndId: through, updatedAt: new Date() },
        });
      await tx
        .update(messageThread)
        .set({ updatedAt: new Date() })
        .where(eq(messageThread.id, thread.id));
      // A meta-only advance carries no system message, so nothing else admits
      // the local fan-out that publishes the new mirror cursor to members.
      // Membership transitions already rode their system message's fan-out.
      if ((feed?.metaEndId ?? 0n) < through && transitions === 0) {
        const head = await tx.execute<{ head: number }>(sql`
          SELECT COALESCE(max(seq), 0) AS head FROM "Message"
          WHERE "threadId" = ${thread.id}`);
        await enqueueThreadFanoutInTx(tx, threadLock, {
          threadId: thread.id,
          messageEndSeq: head.rows[0].head,
          tombstoneEndSeq: thread.tombstoneEndSeq,
        });
      }
      const projection = await this.applyCommittedGroupMetaInTx(
        tx,
        payload,
        threadLock,
      );
      const clientFeedUpdates =
        projection.threadId > 0
          ? await this.clientStateFeed.publishGroupStateToLocalAccountsInTx(
              tx,
              projection.threadId,
            )
          : [];
      const [completed] = await tx
        .update(durableTask)
        .set({
          status: 'SUCCEEDED',
          completedAt: new Date(),
          resultCode: null,
          lastError: null,
        })
        .where(
          and(
            eq(durableTask.id, taskId),
            eq(durableTask.status, 'ASYNC_PROCESSING'),
          ),
        )
        .returning({ id: durableTask.id });
      if (!completed)
        throw new Error('async group-meta task could not be finalized');
      return {
        clientFeedUpdates,
        statePushDomains: projection.statePushDomains,
      };
    });
  }

  private async writeObservedMembershipTransitionsInTx(
    tx: DatabaseTransaction,
    payload: GroupMetaSyncTaskPayload,
    threadId: number,
    threadLock: ThreadContentLock,
    after: bigint,
    through: bigint,
  ): Promise<number> {
    const transitions = await tx.execute<
      Record<string, unknown> &
        NamespacedAddress & { operation: 'UPSERT' | 'DEPART' }
    >(sql`
      WITH transitions AS (
        SELECT "feedId", "memberAccount" AS account, "memberDomain" AS domain,
               "memberNamespaceId" AS "namespaceId", operation,
               lag(operation) OVER (
                 PARTITION BY "memberAccount", "memberDomain", "memberNamespaceId"
                 ORDER BY "feedId"
               ) AS previous
        FROM "GroupMetaMemberFeed"
        WHERE "threadId" = ${payload.groupId} AND "feedId" <= ${through}
      )
      SELECT account, domain, "namespaceId", operation FROM transitions
      WHERE "feedId" > ${after} AND (
        (operation = 'UPSERT' AND previous IS DISTINCT FROM 'UPSERT')
        OR (operation = 'DEPART' AND previous = 'UPSERT' AND domain <> 'local')
      )
      ORDER BY "feedId"
    `);
    if (!transitions.rows.length) return 0;
    const recipientUserIds = await readCurrentLocalAuthorizedGroupMemberIdsInTx(
      tx,
      {
        groupId: payload.groupId,
        threadId,
      },
    );
    if (!recipientUserIds.length) return 0;
    // Joins follow the authoritative roster for both local and remote members. Local departures
    // already have a directed relationship boundary, so only remote departures are included.
    // The writer admits local content fanout atomically with this round's committed cursor.
    for (const { operation, ...member } of transitions.rows)
      await this.messages.writeSystemMessageInTx(
        tx,
        threadId,
        {
          type:
            operation === 'UPSERT'
              ? SystemMessageType.GROUP_JOINED
              : SystemMessageType.GROUP_LEFT,
          member,
        },
        { threadLock },
      );
    return transitions.rows.length;
  }

  private async applyCommittedGroupMetaInTx(
    tx: DatabaseTransaction,
    payload: GroupMetaSyncTaskPayload,
    threadLock: ThreadContentLock,
  ) {
    const [mirror] = await tx
      .select({
        threadId: messageThread.id,
      })
      .from(group)
      .innerJoin(messageThread, eq(messageThread.id, group.id))
      .where(eq(group.id, payload.groupId))
      .limit(1);
    if (!mirror?.threadId)
      throw new Error('group-meta mirror thread is missing');
    const roster = await tx.execute<{
      account: string;
      domain: string;
      role: GroupRole;
      localUserId: number | null;
    }>(sql`
      SELECT latest.account, latest.domain,
             latest.body ->> 'role' AS role,
             local_identity.id AS "localUserId"
      FROM (
        SELECT DISTINCT ON (member_fact."memberDomain", member_fact."memberAccount")
          member_fact."memberAccount" AS account,
          member_fact."memberDomain" AS domain,
          member_fact."memberNamespaceId" AS "namespaceId",
          member_fact.operation,
          member_fact.body
        FROM "GroupMetaMemberFeed" member_fact
        WHERE member_fact."threadId" = ${payload.groupId}
        ORDER BY member_fact."memberDomain", member_fact."memberAccount",
                 member_fact."feedId" DESC
      ) latest
      LEFT JOIN "Account" local_identity
        ON latest.domain = 'local' AND latest."namespaceId" = 0
       AND local_identity.account = latest.account
       AND local_identity.domain = 'local'
       AND local_identity."namespaceId" = 0
      WHERE latest.operation = 'UPSERT'
    `);
    const owners = roster.rows.filter(
      (member) => member.role === GroupRole.OWNER,
    );
    if (roster.rows.length > 0 && owners.length !== 1)
      throw new Error('group-meta roster must have exactly one owner');
    for (const member of roster.rows) {
      if (member.localUserId === null) continue;
      await ensureLocalAccountThreadStateInTx(tx, {
        threadId: mirror.threadId,
        localUserId: member.localUserId,
        role: member.role,
      });
    }
    return this.groupRosterProjection.applyInTx(tx, {
      peerDomain: payload.peerDomain,
      namespaceId: payload.namespaceId,
      groupAccount: payload.groupAccount,
      active: roster.rows.some((member) => member.localUserId !== null),
      dissolved: roster.rows.length === 0,
      owner:
        owners.length === 0
          ? null
          : { account: owners[0]!.account, domain: owners[0]!.domain },
      changes: [],
      threadLock,
    });
  }
}

export interface GroupMetaSyncCompletionEffect {
  clientFeedUpdates: PendingClientStateFeedUpdate[];
  statePushDomains: string[];
}

type ValidGroupMetaItem =
  | {
      feedId: bigint;
      operation: 'UPSERT';
      account: string;
      domain: string;
      role: GroupRole;
      profileRev: number;
    }
  | {
      feedId: bigint;
      operation: 'DEPART';
      account: string;
      domain: string;
    }
  | {
      feedId: bigint;
      operation: 'GROUP_PROFILE';
      profileRev: number;
    };

function validateItem(
  item: GroupMetaFeedItem,
  mode: 'full' | 'delta',
): ValidGroupMetaItem {
  const feedId = BigInt(item.feedId);
  if (item.operation === 'GROUP_PROFILE') {
    requireKeys(item, ['feedId', 'operation', 'body']);
    requireKeys(item.body, ['profileRev']);
    if (!isProfileRev(item.body.profileRev))
      throw new Error('invalid group-meta profile item');
    return {
      feedId,
      operation: 'GROUP_PROFILE',
      profileRev: item.body.profileRev,
    };
  }
  if (
    !isValidSomfpUserAccount(item.account) ||
    item.account !== normalizeAccount(item.account) ||
    !isValidSomfpDomain(item.domain)
  )
    throw new Error('invalid group-meta member address');
  if (item.operation === 'DEPART') {
    requireKeys(item, ['feedId', 'account', 'domain', 'operation']);
    if (mode === 'full')
      throw new Error('full group-meta cannot contain DEPART');
    return {
      feedId,
      operation: 'DEPART',
      account: item.account,
      domain: item.domain,
    };
  }
  requireKeys(item, ['feedId', 'account', 'domain', 'operation', 'body']);
  requireKeys(item.body, ['role', 'profileRev']);
  if (
    !Object.values(GroupRole).includes(item.body.role as GroupRole) ||
    !isProfileRev(item.body.profileRev)
  )
    throw new Error('invalid group-meta member body');
  return {
    feedId,
    operation: 'UPSERT',
    account: item.account,
    domain: item.domain,
    role: item.body.role as GroupRole,
    profileRev: item.body.profileRev as number,
  };
}

async function lockTaskInTx(
  tx: DatabaseTransaction,
  taskId: bigint,
  expectedStatus: 'PROCESSING' | 'ASYNC_PROCESSING' = 'ASYNC_PROCESSING',
): Promise<DurableTask> {
  const [task] = await tx
    .select()
    .from(durableTask)
    .where(eq(durableTask.id, taskId))
    .for('no key update')
    .limit(1);
  if (!task || task.status !== expectedStatus)
    throw new Error(
      'group-meta task is no longer active in the expected phase',
    );
  return task;
}

async function requireMirrorInTx(
  tx: DatabaseTransaction,
  payload: GroupMetaSyncTaskPayload,
): Promise<void> {
  const mirror = await tx
    .select({ id: group.id })
    .from(group)
    .where(
      and(
        eq(group.id, payload.groupId),
        eq(groupStateFields.account, payload.groupAccount),
        eq(groupStateFields.domain, payload.peerDomain),
        eq(groupStateFields.namespaceId, payload.namespaceId),
      ),
    )
    .limit(1);
  if (mirror.length === 0)
    throw new Error('group-meta mirror identity changed');
}

function requireSamePull(
  currentPayload: GroupMetaSyncTaskPayload,
  currentCheckpoint: GroupMetaSyncCheckpoint,
  expectedPayload: GroupMetaSyncTaskPayload,
  expectedCheckpoint: Extract<GroupMetaSyncCheckpoint, { phase: 'PULL' }>,
): void {
  requireSameTask(currentPayload, expectedPayload);
  if (!isDeepStrictEqual(currentCheckpoint, expectedCheckpoint))
    throw new Error('group-meta pull checkpoint changed');
}

function requireSameTask(
  current: GroupMetaSyncTaskPayload,
  expected: GroupMetaSyncTaskPayload,
): void {
  if (!isDeepStrictEqual(current, expected))
    throw new Error('group-meta sync payload changed');
}

function requireKeys(value: object, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    keys.length !== required.length ||
    keys.some((key, index) => key !== required[index])
  )
    throw new Error('invalid group-meta item shape');
}

function isProfileRev(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
