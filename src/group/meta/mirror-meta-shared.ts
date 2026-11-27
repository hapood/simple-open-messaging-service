import { and, eq, sql } from 'drizzle-orm';
import { normalizeAccount } from '../../common/account.js';
import {
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../../common/locks/thread-content-lock.js';
import { lockBusinessAccountsInTx } from '../../common/locks/account-business-lock.js';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { GroupRole } from '../../database/enums.js';
import { groupMeta, messageThread } from '../../database/schema.js';
import { groupStateFields, groupStateSql } from '../shared/group-state.js';
import { upsertCurrentGroupMetaFactsInTx } from './current-group-meta-fact.js';
import { publishClientGroupFactInTx } from './publish-client-group-fact-in-tx.js';
import { MessageService } from '../../message/message.service.js';
import { SystemMessageType } from '../../message/system-message.js';
import { collectCommittedProfileWork } from '../../message/collect-committed-profile-work.js';
import type { MessageProfileWorkCommittedEvent } from '../../message/message-profile-work.event.js';
import { groupMemberProfileAddress } from './group-member-profile-address.js';
import { readCurrentLocalAuthorizedGroupMemberIdsInTx } from './current-group-roster.js';
import { reconcileClientMemberCountInTx } from './reconcile-client-member-count-in-tx.js';

export interface MirrorGroupAddress {
  account: string;
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
  metaRecoveryThroughId: number;
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
    metaEndId: number;
    clientMetaEndId: number;
    metaTargetId: number;
    metaProcessedThroughId: number;
    metaRecoveryThroughId: number;
  }>(sql`
    SELECT thread.id AS "threadId",
      ${groupStateFields.account} AS "groupAccount",
      feed."metaEndId", feed."clientMetaEndId", feed."metaTargetId",
      feed."metaProcessedThroughId", feed."metaRecoveryThroughId"
    FROM ${groupStateSql} group_state
    JOIN "MessageThread" thread ON thread.id = group_state.id
    JOIN "GroupMeta" feed ON feed."threadId" = thread.id
    WHERE ${groupStateFields.account} = ${normalizeAccount(group.account)}
      AND ${groupStateFields.namespaceId} = ${group.publisherNamespaceId}
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) throw new Error('group-meta mirror cursor is missing');
  if (row.metaEndId !== 0)
    throw new Error(
      'mirror group meta does not allocate canonical coordinates',
    );
  return {
    threadId: row.threadId,
    groupAccount: row.groupAccount,
    metaEndId: row.metaEndId,
    metaTargetId: row.metaTargetId,
    metaProcessedThroughId: row.metaProcessedThroughId,
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
    const originCreatedAt = new Date(item.originCreatedAt);
    await upsertCurrentGroupMetaFactsInTx(tx, [
      {
        threadId,
        feedId: item.feedId,
        originCreatedAt,
        operation: 'GROUP_ANNOUNCEMENT',
        body: { text: item.text },
      },
    ]);
    await publishClientGroupFactInTx(
      tx,
      await requireThreadContentLockInTx(tx, threadId),
      {
        operation: 'GROUP_ANNOUNCEMENT',
        sourceFeedId: item.feedId,
        originCreatedAt,
        body: { text: item.text },
      },
    );
    return;
  }
  if (item.operation === 'GROUP_PROFILE') {
    const originCreatedAt = new Date(item.originCreatedAt);
    await upsertCurrentGroupMetaFactsInTx(tx, [
      {
        threadId,
        feedId: item.feedId,
        originCreatedAt,
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

/** Opens a full window the same way for the first snapshot and for a restart.
 * The recovery through is fixed at the merged target, the scan cursor returns
 * to zero, and current members become MEMBER_DEPART with a new updatedAt.
 * Those members also become one GROUP_LEFT batch. Lock order: group Account State scope, Thread
 * Content lock, GroupMeta, roster facts. */
export async function beginMirrorMetaRecoveryInTx(
  tx: DatabaseTransaction,
  group: MirrorGroupAddress,
  availableThrough?: number,
  messages?: Pick<MessageService, 'writeSystemMessageInTx'>,
): Promise<MessageProfileWorkCommittedEvent[]> {
  await lockMirrorGroupInTx(tx, group);
  const mirror = await requireMirrorMetaInTx(tx, group);
  const target = Math.max(mirror.metaTargetId, availableThrough ?? 0);
  if (target === 0) return [];
  const threadLock = await requireThreadContentLockInTx(tx, mirror.threadId);
  const existing = await tx.execute<{
    account: string;
    namespaceId: number;
    profileRev: number;
  }>(sql`
    SELECT body->>'account' AS account,
      (body->>'namespaceId')::integer AS "namespaceId",
      COALESCE((body->>'profileRev')::integer, 0) AS "profileRev"
    FROM "GroupMetaMemberFeed"
    WHERE "threadId" = ${mirror.threadId} AND operation = 'MEMBER_UPSERT'
  `);
  await tx.execute(sql`
    UPDATE "GroupMetaMemberFeed"
    SET operation = 'MEMBER_DEPART', "updatedAt" = CURRENT_TIMESTAMP
    WHERE "threadId" = ${mirror.threadId} AND operation = 'MEMBER_UPSERT'
  `);
  await reconcileClientMemberCountInTx(tx, threadLock);
  await tx
    .update(groupMeta)
    .set({
      metaTargetId: target,
      metaProcessedThroughId: 0,
      metaRecoveryThroughId: target,
      updatedAt: new Date(),
    })
    .where(eq(groupMeta.threadId, mirror.threadId));
  if (!messages || existing.rows.length === 0) return [];
  const publisher = await tx.execute<{ localNamespaceId: number | null }>(sql`
    SELECT "peerAssignedLocalNamespaceId" AS "localNamespaceId"
    FROM "IdentityNamespace"
    WHERE id = ${group.publisherNamespaceId} AND "retiredAt" IS NULL
  `);
  const localNamespaceId = publisher.rows[0]?.localNamespaceId;
  if (localNamespaceId == null)
    throw new Error(
      'mirror publisher has no recognized local namespace binding',
    );
  const left = existing.rows
    .filter((member) => member.namespaceId !== localNamespaceId)
    .map((member) =>
      groupMemberProfileAddress({
        account: member.account,
        publisherNamespaceId: group.publisherNamespaceId,
        profileNamespaceId: member.namespaceId,
        profileRev: member.profileRev,
      }),
    );
  if (left.length === 0) return [];
  const recipients = await readCurrentLocalAuthorizedGroupMemberIdsInTx(tx, {
    groupId: mirror.threadId,
    threadId: mirror.threadId,
  });
  if (recipients.length === 0) return [];
  const result = await messages.writeSystemMessageInTx(
    tx,
    mirror.threadId,
    {
      type: SystemMessageType.GROUP_LEFT,
      members: left.slice(0, 5) as [(typeof left)[0], ...(typeof left)[0][]],
      totalCount: left.length,
    },
    { threadLock },
  );
  const work = collectCommittedProfileWork([
    {
      threadType: 'GROUP',
      threadId: mirror.threadId,
      seq: result.message.seq,
      publisherNamespaceId: group.publisherNamespaceId,
      creator: {
        account: result.message.creator!.account,
        profileNamespaceId: result.message.creator!.namespaceId,
        profileRev: result.message.profileRev,
      },
      contentType: result.message.contentType,
      content: result.message.content,
      localState: result.message.localState,
      isDeleted: false,
      groupAccount: group.account,
    },
  ]);
  return work.demands.length > 0 || work.evidenceProjections.length > 0
    ? [work]
    : [];
}

/** Re-opens the meta recovery drain after the origin compacted below the
 * mirror's cursor. Same window start as the first snapshot. */
export async function reopenMirrorMetaRecoveryInTx(
  tx: DatabaseTransaction,
  group: MirrorGroupAddress,
  availableThrough?: number,
  messages?: Pick<MessageService, 'writeSystemMessageInTx'>,
): Promise<MessageProfileWorkCommittedEvent[]> {
  return beginMirrorMetaRecoveryInTx(tx, group, availableThrough, messages);
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
    .select({
      metaEndId: groupMeta.metaEndId,
      metaProcessedThroughId: groupMeta.metaProcessedThroughId,
      metaTargetId: groupMeta.metaTargetId,
    })
    .from(groupMeta)
    .where(eq(groupMeta.threadId, input.threadId))
    .limit(1);
  if (!feed) throw new Error('group-meta mirror cursor disappeared');
  if (feed.metaEndId !== 0)
    throw new Error(
      'mirror group meta does not allocate canonical coordinates',
    );
  if (
    feed.metaProcessedThroughId > input.through ||
    feed.metaTargetId < input.through
  )
    throw new Error('group-meta mirror source cursor moved beyond task target');
  await assertMirrorRosterOwnersInTx(tx, input.threadId);
  await tx
    .update(groupMeta)
    .set({
      metaRecoveryThroughId: 0,
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
