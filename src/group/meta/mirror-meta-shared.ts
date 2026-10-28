import { and, eq, sql } from 'drizzle-orm';
import { normalizeAccount } from '../../common/account.js';
import type { ThreadContentLock } from '../../common/locks/thread-content-lock.js';
import { lockBusinessAccountsInTx } from '../../common/locks/account-business-lock.js';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { GroupRole } from '../../database/enums.js';
import {
  groupMeta,
  groupMetaMemberFeed,
  messageThread,
} from '../../database/schema.js';
import { groupStateFields, groupStateSql } from '../shared/group-state.js';
import { upsertCurrentGroupMetaFactsInTx } from './current-group-meta-fact.js';

export interface MirrorGroupAddress {
  account: string;
  domain: string;
  publisherNamespaceId: number;
}

/** One validated replica item pulled from the origin's Group Meta feed. The
 * member/group subject identity is (account, namespaceId) in the publisher's
 * coordinate space and is stored verbatim; the display domain resolves through
 * publisher-scoped namespace bindings, never from the item. */
export type MirrorMetaReplicatedItem = {
  originCreatedAt: number;
} & (
  | {
      feedId: number;
      operation: 'MEMBER_UPSERT';
      account: string;
      namespaceId: number;
      role: GroupRole;
      profileRev: number;
    }
  | {
      feedId: number;
      operation: 'MEMBER_DEPART';
      account: string;
      namespaceId: number;
      role: GroupRole;
      profileRev: number;
    }
  | {
      feedId: number;
      operation: 'GROUP_PROFILE';
      account: string;
      namespaceId: number;
      profileRev: number;
    }
  | {
      feedId: number;
      operation: 'GROUP_ANNOUNCEMENT';
      text: string | null;
    }
);

export interface MirrorMetaCursor {
  threadId: number;
  groupAccount: string;
  metaEndId: number;
  metaTargetId: number;
  metaProcessedThroughId: number;
  metaRecoveryThroughId: number | null;
}

export async function lockMirrorGroupInTx(
  tx: DatabaseTransaction,
  group: MirrorGroupAddress,
): Promise<void> {
  await lockBusinessAccountsInTx(tx, [
    {
      account: normalizeAccount(group.account),
      profileNamespaceId: group.publisherNamespaceId,
    },
  ]);
}

/** The mirror's Group Meta cursor row, or null when this peer hosts no mirror
 * for the group. Group coordinates are thread ids, so the cursor row may not
 * exist yet even though the mirror shell does. */
async function readMirrorMetaInTx(
  tx: DatabaseTransaction,
  group: MirrorGroupAddress,
): Promise<MirrorMetaCursor | null> {
  const result = await tx.execute<{
    threadId: number;
    groupAccount: string;
    metaEndId: number | null;
    metaTargetId: number | null;
    metaProcessedThroughId: number | null;
    metaRecoveryThroughId: number | null;
  }>(sql`
    SELECT thread.id AS "threadId",
      ${groupStateFields.account} AS "groupAccount",
      feed."metaEndId", feed."metaTargetId",
      feed."metaProcessedThroughId", feed."metaRecoveryThroughId"
    FROM ${groupStateSql} group_state
    JOIN "MessageThread" thread ON thread.id = group_state.id
    LEFT JOIN "GroupMeta" feed ON feed."threadId" = thread.id
    WHERE ${groupStateFields.account} = ${normalizeAccount(group.account)}
      AND ${groupStateFields.namespaceId} = ${group.publisherNamespaceId}
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row || row.metaEndId === null) return null;
  return {
    threadId: row.threadId,
    groupAccount: row.groupAccount,
    metaEndId: row.metaEndId,
    metaTargetId: row.metaTargetId!,
    metaProcessedThroughId: row.metaProcessedThroughId!,
    metaRecoveryThroughId: row.metaRecoveryThroughId,
  };
}

export async function requireMirrorMetaInTx(
  tx: DatabaseTransaction,
  group: MirrorGroupAddress,
): Promise<MirrorMetaCursor> {
  const cursor = await readMirrorMetaInTx(tx, group);
  if (!cursor) throw new Error('group-meta mirror identity changed');
  return cursor;
}

/** Full and delta pages upsert each stable subject key and its coordinate. A
 * mirror MEMBER_DEPART retains a tombstone at the item's coordinate: the feed
 * is a shared coordinate space, and deleting the row would leave a hole that
 * delta readers skip past without ever learning the departure. Current-roster
 * and full-page readers filter to MEMBER_UPSERT rows, so the tombstone stays
 * invisible to them. */
export async function applyMirrorMetaFactInTx(
  tx: DatabaseTransaction,
  threadId: number,
  group: MirrorGroupAddress,
  item: MirrorMetaReplicatedItem,
  mode: 'full' | 'delta',
): Promise<void> {
  if (mode === 'full' && item.operation === 'MEMBER_DEPART')
    throw new Error('a full group-meta snapshot cannot contain MEMBER_DEPART');
  if (item.operation === 'GROUP_ANNOUNCEMENT') {
    await upsertCurrentGroupMetaFactsInTx(tx, [
      {
        threadId,
        feedId: item.feedId,
        originCreatedAt: new Date(item.originCreatedAt),
        operation: 'GROUP_ANNOUNCEMENT',
        body: { text: item.text },
      },
    ]);
    return;
  }
  if (item.operation === 'GROUP_PROFILE') {
    await upsertCurrentGroupMetaFactsInTx(tx, [
      {
        threadId,
        feedId: item.feedId,
        originCreatedAt: new Date(item.originCreatedAt),
        operation: 'GROUP_PROFILE',
        body: {
          account: item.account,
          namespaceId: item.namespaceId,
          profileRev: item.profileRev,
        },
      },
    ]);
    await tx
      .update(groupMeta)
      .set({ profileRev: item.profileRev, updatedAt: new Date() })
      .where(eq(groupMeta.threadId, threadId));
    return;
  }
  await upsertCurrentGroupMetaFactsInTx(tx, [
    {
      threadId,
      feedId: item.feedId,
      originCreatedAt: new Date(item.originCreatedAt),
      operation: item.operation,
      body: {
        account: item.account,
        namespaceId: item.namespaceId,
        role: item.role,
        profileRev: item.profileRev,
      },
    },
  ]);
}

/** Fences the scan cursor against the round's fixed target. */
export async function advanceMirrorProcessedThroughInTx(
  tx: DatabaseTransaction,
  threadId: number,
  processedThrough: number,
  target: number,
): Promise<void> {
  const [updated] = await tx
    .update(groupMeta)
    .set({
      metaProcessedThroughId: sql`GREATEST(${groupMeta.metaProcessedThroughId}, ${processedThrough})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(groupMeta.threadId, threadId),
        sql`${groupMeta.metaTargetId} >= ${target}`,
      ),
    )
    .returning({ threadId: groupMeta.threadId });
  if (!updated)
    throw new Error(
      `mirror group ${threadId} has no meta target for this round`,
    );
}

/** A clipped bounded drain may omit the owner's newer fact, but cannot
 * legitimately project two owners at the same boundary. */
async function assertMirrorRosterOwnersInTx(
  tx: DatabaseTransaction,
  threadId: number,
): Promise<void> {
  const roster = await tx.execute<{ role: string }>(sql`
    SELECT fact.body ->> 'role' AS role
    FROM "GroupMetaMemberFeed" fact
    WHERE fact."threadId" = ${threadId} AND fact.operation = 'MEMBER_UPSERT'
  `);
  const owners = roster.rows.filter(
    (member) => member.role === GroupRole.OWNER,
  ).length;
  if (owners > 1)
    throw new Error('group-meta roster cannot have multiple owners');
}

/** Re-opens the meta recovery drain after the origin compacted below the
 * mirror's delta cursor: the scan cursor zeroes and the drain re-fixes at the
 * merged target in one statement. A no-op while nothing has been scanned or
 * no target is known. */
export async function reopenMirrorMetaRecoveryInTx(
  tx: DatabaseTransaction,
  group: MirrorGroupAddress,
  availableThrough?: number,
): Promise<void> {
  await lockMirrorGroupInTx(tx, group);
  const mirror = await requireMirrorMetaInTx(tx, group);
  const target = Math.max(mirror.metaTargetId, availableThrough ?? 0);
  if (target === 0) return;
  await tx
    .update(groupMeta)
    .set({
      metaTargetId: target,
      metaProcessedThroughId: 0,
      metaRecoveryThroughId: target,
      updatedAt: new Date(),
    })
    .where(eq(groupMeta.threadId, mirror.threadId));
}

/** The round's final transaction: advance the applied end to the round's
 * fixed target, close the open recovery drain if any, and refresh the
 * group-shell projection so members see the completed roster state. */
export async function finalizeMirrorMetaRecoveryInTx(
  tx: DatabaseTransaction,
  input: {
    threadId: number;
    through: number;
    threadLock: ThreadContentLock;
  },
): Promise<void> {
  const [feed] = await tx
    .select({ metaEndId: groupMeta.metaEndId })
    .from(groupMeta)
    .where(eq(groupMeta.threadId, input.threadId))
    .limit(1);
  if (!feed) throw new Error('group-meta mirror cursor disappeared');
  if (feed.metaEndId > input.through)
    throw new Error('group-meta mirror cursor moved beyond task target');
  await assertMirrorRosterOwnersInTx(tx, input.threadId);
  await tx
    .update(groupMeta)
    .set({
      metaEndId: input.through,
      metaRecoveryThroughId: null,
      updatedAt: new Date(),
    })
    .where(eq(groupMeta.threadId, input.threadId));
  // Side A is always the local endpoint: a mirrored (remotely hosted) group's
  // local member sits on A, a locally hosted group's member on B with
  // namespace 0. An active pair on either side keeps the mirror live.
  const membership = await tx.execute<{ active: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM "RelationshipPair" pair
      WHERE pair.kind = 'GROUP_MEMBER' AND pair."threadId" = ${input.threadId}
        AND pair.active = true
        AND (
          pair."endpointAType" = 'USER'
          OR (pair."endpointBType" = 'USER'
            AND pair."endpointBNamespaceId" = 0)
        )
    ) AS active
  `);
  const dissolved = !membership.rows[0]?.active;
  await tx
    .update(messageThread)
    .set({ groupDissolvedAt: dissolved ? new Date() : null })
    .where(eq(messageThread.id, input.threadId));
}
