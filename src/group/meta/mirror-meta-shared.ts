import { and, eq, sql } from 'drizzle-orm';
import { normalizeAccount } from '../../common/account.js';
import { toClientIdentity, toClientIdentityOrNull } from '../../common/client-identity.js';
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

/** One validated replica item pulled from the origin's Group Meta feed. */
export type MirrorMetaReplicatedItem =
  | {
      feedId: number;
      operation: 'MEMBER_UPSERT';
      account: string;
      domain: string;
      role: GroupRole;
      profileNamespaceId: number;
      profileRev: number;
    }
  | {
      feedId: number;
      operation: 'MEMBER_DEPART';
      account: string;
      domain: string;
      role: GroupRole;
      profileNamespaceId: number;
      profileRev: number;
    }
  | {
      feedId: number;
      operation: 'GROUP_PROFILE';
      profileNamespaceId: number;
      profileRev: number;
    }
  | {
      feedId: number;
      operation: 'GROUP_ANNOUNCEMENT';
      text: string | null;
    };

/** Convert a validated origin wire address into this server's canonical member
 * address before any mirror fact or profile-demand logic runs. A member whose
 * wire domain is this server's domain is local here; every other domain remains
 * remote. */
export function normalizeMirrorMetaMemberAddress(
  account: string,
  domain: string,
  profileNamespaceId: number,
): { account: string; domain: string; profileNamespaceId: number } {
  const identity = toClientIdentityOrNull({
    account,
    domain,
    namespaceId: profileNamespaceId,
  });
  if (!identity) throw new Error('invalid local subject namespace');
  return {
    account: identity.account,
    domain: identity.domain,
    profileNamespaceId: identity.namespaceId,
  };
}

/** Normalize member addresses at the mirror wire boundary. All downstream
 * persistence, roster, and profile-demand code consumes this canonical item. */
export function normalizeMirrorMetaReplicatedItem(
  group: Pick<MirrorGroupAddress, 'publisherNamespaceId'>,
  item: MirrorMetaReplicatedItem,
): MirrorMetaReplicatedItem {
  if (item.operation !== 'MEMBER_UPSERT' && item.operation !== 'MEMBER_DEPART')
    return item;
  const member = normalizeMirrorMetaMemberAddress(
    item.account,
    item.domain,
    item.profileNamespaceId,
  );
  return {
    ...item,
    account: member.account,
    domain: member.domain,
    profileNamespaceId: member.profileNamespaceId,
  };
}

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
    { account: normalizeAccount(group.account), domain: group.domain },
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
      AND ${groupStateFields.domain} = ${group.domain}
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

/** Full and delta pages upsert each stable key and its coordinate. A mirror
 * MEMBER_DEPART retains a tombstone at the item's coordinate: the feed is a shared
 * coordinate space, and deleting the row would leave a hole that delta
 * readers skip past without ever learning the departure. Current-roster and
 * full-page readers filter to MEMBER_UPSERT rows, so the tombstone stays invisible
 * to them. */
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
    await tx
      .update(groupMeta)
      .set({
        announcementFeedId: item.feedId,
        announcementText: item.text,
        updatedAt: new Date(),
      })
      .where(eq(groupMeta.threadId, threadId));
    return;
  }
  if (item.operation === 'MEMBER_DEPART') {
    const subject = toClientIdentity({
      account: item.account,
      domain: item.domain,
      namespaceId: item.profileNamespaceId,
    });
    await upsertCurrentGroupMetaFactsInTx(tx, [
      {
        threadId,
        feedId: item.feedId,
        memberAccount: subject.account,
        profileNamespaceId: subject.namespaceId,
        operation: 'MEMBER_DEPART',
        body: {
          role: item.role,
          profileNamespaceId: item.profileNamespaceId,
          profileRev: item.profileRev,
        },
      },
    ]);
    return;
  }
  await upsertCurrentGroupMetaFactsInTx(tx, [
    currentMirrorMetaFact(threadId, group, item),
  ]);
  if (item.operation === 'GROUP_PROFILE')
    await tx
      .update(groupMeta)
      .set({ profileRev: item.profileRev, updatedAt: new Date() })
      .where(eq(groupMeta.threadId, threadId));
}

/** Translate one full or delta upsert into the same current-fact key. */
export function currentMirrorMetaFact(
  threadId: number,
  group: MirrorGroupAddress,
  item: Extract<
    MirrorMetaReplicatedItem,
    { operation: 'MEMBER_UPSERT' | 'GROUP_PROFILE' }
  >,
): typeof groupMetaMemberFeed.$inferInsert {
  const body =
    item.operation === 'MEMBER_UPSERT'
      ? {
          role: item.role,
          profileNamespaceId: item.profileNamespaceId,
          profileRev: item.profileRev,
        }
      : {
          profileNamespaceId: item.profileNamespaceId,
          profileRev: item.profileRev,
        };
  const subject =
    item.operation === 'GROUP_PROFILE'
      ? {
          account: group.account,
          domain: group.domain,
          namespaceId: group.publisherNamespaceId,
        }
      : toClientIdentity({
          account: item.account,
          domain: item.domain,
          namespaceId: item.profileNamespaceId,
        });
  return {
    threadId,
    feedId: item.feedId,
    memberAccount: subject.account,
    profileNamespaceId: subject.namespaceId,
    operation: item.operation,
    body,
  };
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
  const membership = await tx.execute<{ active: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM "RelationshipPair" pair
      WHERE pair.kind = 'GROUP_MEMBER' AND pair."threadId" = ${input.threadId}
        AND pair.active = true AND pair."endpointBType" = 'USER'
        AND pair."endpointANamespaceId" = 0
    ) AS active
  `);
  const dissolved = !membership.rows[0]?.active;
  await tx
    .update(messageThread)
    .set({
      groupDissolvedAt: dissolved ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(messageThread.id, input.threadId));
}
