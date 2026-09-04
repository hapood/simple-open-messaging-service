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
  group,
  groupMetaFeed,
  groupMetaMemberFeed,
  groupMetaProfileFeed,
  messageThread,
} from '../database/schema.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { upsertSourceUserInTx } from '../user/source-user.js';
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
  ) {}

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
      const locked = await lockTaskInTx(tx, taskId);
      const current = readGroupMetaSyncTask(locked);
      requireSamePull(current.payload, current.checkpoint, payload, checkpoint);
      await tx
        .update(durableTask)
        .set({
          checkpoint: {
            phase: 'PULL',
            mode: 'full',
            after: recovery.resumeAfter.toString(),
            through: through.toString(),
          },
        })
        .where(eq(durableTask.id, taskId));
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
      await tx
        .update(durableTask)
        .set({ checkpoint: nextCheckpoint })
        .where(eq(durableTask.id, taskId));
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
        .where(eq(groupMetaProfileFeed.groupId, payload.groupId))
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
            .where(eq(groupMetaProfileFeed.groupId, payload.groupId));
        return;
      }
      await tx
        .insert(groupMetaProfileFeed)
        .values({
          groupId: payload.groupId,
          feedId: item.feedId,
          profileRev: item.profileRev,
          fullSyncRunId: mode === 'full' ? taskId : null,
        })
        .onConflictDoUpdate({
          target: groupMetaProfileFeed.groupId,
          set: {
            feedId: item.feedId,
            profileRev: item.profileRev,
            fullSyncRunId: mode === 'full' ? taskId : null,
            updatedAt: new Date(),
          },
        });
      return;
    }

    const memberUserId = await upsertSourceUserInTx(tx, {
      account: item.account,
      domain: item.domain,
      namespaceId: payload.namespaceId,
      name: item.account,
      avatar: null,
      bio: '',
      profileRev: 0,
    });
    if (mode === 'full') {
      const duplicate = await tx
        .select({ feedId: groupMetaMemberFeed.feedId })
        .from(groupMetaMemberFeed)
        .where(
          and(
            eq(groupMetaMemberFeed.groupId, payload.groupId),
            eq(groupMetaMemberFeed.memberUserId, memberUserId),
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
        memberUserId: groupMetaMemberFeed.memberUserId,
        operation: groupMetaMemberFeed.operation,
        body: groupMetaMemberFeed.body,
      })
      .from(groupMetaMemberFeed)
      .where(
        and(
          eq(groupMetaMemberFeed.groupId, payload.groupId),
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
        existing.memberUserId !== memberUserId ||
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
              eq(groupMetaMemberFeed.groupId, payload.groupId),
              eq(groupMetaMemberFeed.feedId, item.feedId),
            ),
          );
      return;
    }
    await tx.insert(groupMetaMemberFeed).values({
      groupId: payload.groupId,
      feedId: item.feedId,
      memberUserId,
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
            eq(groupMetaMemberFeed.groupId, payload.groupId),
            sql`${groupMetaMemberFeed.fullSyncRunId} IS DISTINCT FROM ${taskId}`,
          ),
        )
        .orderBy(groupMetaMemberFeed.feedId)
        .limit(CLEANUP_PAGE_SIZE);
      if (stale.length > 0)
        await tx.delete(groupMetaMemberFeed).where(
          and(
            eq(groupMetaMemberFeed.groupId, payload.groupId),
            inArray(
              groupMetaMemberFeed.feedId,
              stale.map((row) => row.feedId),
            ),
          ),
        );
      if (stale.length < CLEANUP_PAGE_SIZE)
        await tx
          .update(durableTask)
          .set({
            checkpoint: {
              phase: 'FINALIZE',
              mode: 'full',
              through: checkpoint.through,
            },
          })
          .where(eq(durableTask.id, taskId));
    });
  }

  private async finalize(
    taskId: bigint,
    payload: GroupMetaSyncTaskPayload,
    checkpoint: Extract<GroupMetaSyncCheckpoint, { phase: 'FINALIZE' }>,
  ): Promise<GroupMetaSyncCompletionEffect> {
    return this.database.db.transaction(async (tx) => {
      const locked = await lockTaskInTx(tx, taskId);
      const current = readGroupMetaSyncTask(locked);
      requireSameTask(current.payload, payload);
      if (!isDeepStrictEqual(current.checkpoint, checkpoint))
        throw new Error('group-meta final checkpoint changed');
      await requireMirrorInTx(tx, payload);
      const roster = await tx.execute<{ role: GroupRole }>(sql`
        SELECT latest.body ->> 'role' AS role
        FROM (
          SELECT DISTINCT ON (member_identity.domain, member_identity.account)
            member_fact.operation, member_fact.body
          FROM "GroupMetaMemberFeed" member_fact
          JOIN "User" member_identity ON member_identity.id = member_fact."memberUserId"
          WHERE member_fact."groupId" = ${payload.groupId}
          ORDER BY member_identity.domain, member_identity.account,
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
        .where(eq(groupMetaProfileFeed.groupId, payload.groupId))
        .limit(1);
      if (!profile) throw new Error('group-meta mirror has no profile item');
      if (checkpoint.mode === 'full' && profile.fullSyncRunId !== taskId)
        throw new Error('full group-meta mirror has no current profile item');
      const through = BigInt(checkpoint.through);
      const [feed] = await tx
        .select({ feedEndId: groupMetaFeed.feedEndId })
        .from(groupMetaFeed)
        .where(eq(groupMetaFeed.groupId, payload.groupId))
        .limit(1);
      if (feed && feed.feedEndId > through)
        throw new Error('group-meta mirror cursor moved beyond task target');
      await tx
        .insert(groupMetaFeed)
        .values({ groupId: payload.groupId, feedEndId: through })
        .onConflictDoUpdate({
          target: groupMetaFeed.groupId,
          set: { feedEndId: through, updatedAt: new Date() },
        });
      await tx
        .update(group)
        .set({ defaultProfileRev: profile.profileRev, updatedAt: new Date() })
        .where(eq(group.id, payload.groupId));
      const projection = await this.applyCommittedGroupMetaInTx(tx, payload);
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

  private async applyCommittedGroupMetaInTx(
    tx: DatabaseTransaction,
    payload: GroupMetaSyncTaskPayload,
  ) {
    const localDomain = loadFederationConfig().domain;
    const [mirror] = await tx
      .select({
        threadId: messageThread.id,
      })
      .from(group)
      .innerJoin(messageThread, eq(messageThread.groupId, group.id))
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
        SELECT DISTINCT ON (member_identity.domain, member_identity.account)
          member_identity.account,
          member_identity.domain,
          member_fact.operation,
          member_fact.body
        FROM "GroupMetaMemberFeed" member_fact
        JOIN "User" member_identity
          ON member_identity.id = member_fact."memberUserId"
        WHERE member_fact."groupId" = ${payload.groupId}
        ORDER BY member_identity.domain, member_identity.account,
                 member_fact."feedId" DESC
      ) latest
      LEFT JOIN "User" local_identity
        ON latest.domain = ${localDomain}
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
): Promise<DurableTask> {
  const [task] = await tx
    .select()
    .from(durableTask)
    .where(eq(durableTask.id, taskId))
    .for('update')
    .limit(1);
  if (!task || task.status !== 'ASYNC_PROCESSING')
    throw new Error('async group-meta task is no longer active');
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
        eq(group.account, payload.groupAccount),
        eq(group.domain, payload.peerDomain),
        eq(group.namespaceId, payload.namespaceId),
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
