import { eq, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import {
  groupMeta,
  groupMetaMemberFeed,
  messageThread,
} from '../../database/schema.js';
import { enqueueThreadFanoutInTx } from '../../message/thread-fanout-task.js';
import { requireGroupThreadContentLockUnderGroupInTx } from '../../common/locks/thread-content-lock.js';
import type { ProfilePrefetchDemand } from '../../profile-resolution/profile-resolution-demand.js';
import { selectMirrorMetaProfileDemand } from './select-mirror-meta-profile-demand.js';
import { upsertCurrentGroupMetaFactsInTx } from './current-group-meta-fact.js';
import type {
  MirrorGroupAddress,
  MirrorMetaReplicatedItem,
} from './mirror-meta-shared.js';
import {
  advanceMirrorProcessedThroughInTx,
  finalizeMirrorMetaRecoveryInTx,
  lockMirrorGroupInTx,
  requireMirrorMetaInTx,
} from './mirror-meta-shared.js';

export interface FullMirrorMetaBatchInput {
  group: MirrorGroupAddress;
  items: readonly MirrorMetaReplicatedItem[];
  /** The open recovery drain's fixed through; the round aborts if it moved. */
  through: number;
  /** The fetched page's scanned-through; the scan cursor advances to it. */
  scannedThrough: number;
  /** True for the drain's last page: the applied end advances to `through`,
   * the drain closes, and the shell projection refreshes here. */
  reachedBoundary: boolean;
}

/** Commit a complete full Group Meta drain in one transaction, without
 * system messages. Clearing and replacing the roster shares its cursor commit.
 * Lock order: group Account State scope, Thread Content lock, GroupMeta and
 * roster facts. */
export async function applyFullMirrorMetaBatchInTx(
  tx: DatabaseTransaction,
  input: FullMirrorMetaBatchInput,
): Promise<{
  threadId: number;
  profileDemands: ProfilePrefetchDemand[];
}> {
  await lockMirrorGroupInTx(tx, input.group);
  const mirror = await requireMirrorMetaInTx(tx, input.group);
  if (mirror.metaRecoveryThroughId === null)
    throw new Error('the meta recovery drain closed during this round');
  if (mirror.metaRecoveryThroughId !== input.through)
    throw new Error('the meta recovery drain changed during this round');
  if (!input.reachedBoundary || input.scannedThrough !== input.through)
    throw new Error('full group-meta requires a complete fixed-through drain');
  const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
    tx,
    mirror.threadId,
    mirror.threadId,
  );
  // Retain facts at the same coordinate so recovery cannot reset their first
  // local persistence time. Remove facts absent from the completed full scan.
  await tx.execute(sql`
    DELETE FROM "GroupMetaMemberFeed"
    WHERE "threadId" = ${mirror.threadId}
      AND "feedId" <> ALL(${sql.param(input.items.map((item) => item.feedId))}::integer[])
  `);
  const profileDemands = input.items
    .map((item) => selectMirrorMetaProfileDemand(input.group, item))
    .filter((demand): demand is ProfilePrefetchDemand => demand !== null);
  type MirrorFactInsert = (typeof groupMetaMemberFeed)['$inferInsert'];
  const facts = input.items.flatMap<MirrorFactInsert>((item) => {
    if (item.operation === 'MEMBER_DEPART')
      throw new Error(
        'a full group-meta snapshot cannot contain MEMBER_DEPART',
      );
    if (item.operation === 'GROUP_ANNOUNCEMENT')
      return [
        {
          threadId: mirror.threadId,
          feedId: item.feedId,
          originCreatedAt: new Date(item.createdAt),
          operation: 'GROUP_ANNOUNCEMENT',
          body: { text: item.text },
        },
      ];
    if (item.operation === 'GROUP_PROFILE')
      return [
        {
          threadId: mirror.threadId,
          feedId: item.feedId,
          originCreatedAt: new Date(item.createdAt),
          operation: 'GROUP_PROFILE' as const,
          body: {
            account: item.account,
            namespaceId: item.namespaceId,
            profileRev: item.profileRev,
          },
        },
      ];
    return [
      {
        threadId: mirror.threadId,
        feedId: item.feedId,
        originCreatedAt: new Date(item.createdAt),
        operation: item.operation,
        body: {
          account: item.account,
          namespaceId: item.namespaceId,
          role: item.role,
          profileRev: item.profileRev,
        },
      },
    ];
  });
  await upsertCurrentGroupMetaFactsInTx(tx, facts);
  const profile = input.items.find(
    (item) => item.operation === 'GROUP_PROFILE',
  );
  if (profile?.operation === 'GROUP_PROFILE')
    await tx
      .update(groupMeta)
      .set({ profileRev: profile.profileRev, updatedAt: new Date() })
      .where(eq(groupMeta.threadId, mirror.threadId));
  const [thread] = await tx
    .select({ tombstoneEndSeq: messageThread.tombstoneEndSeq })
    .from(messageThread)
    .where(eq(messageThread.id, mirror.threadId))
    .limit(1);
  if (!thread) throw new Error('group-meta mirror thread is missing');
  const messageEnd = await tx.execute<{ head: number }>(sql`
    SELECT COALESCE(max(seq), 0)::integer AS head FROM "Message"
    WHERE "threadId" = ${mirror.threadId}`);
  await enqueueThreadFanoutInTx(tx, threadLock, {
    threadId: mirror.threadId,
    messageEndSeq: messageEnd.rows[0]!.head,
    tombstoneEndSeq: thread.tombstoneEndSeq,
  });
  await finalizeMirrorMetaRecoveryInTx(tx, {
    threadId: mirror.threadId,
    through: input.through,
    threadLock,
  });
  await advanceMirrorProcessedThroughInTx(
    tx,
    mirror.threadId,
    input.scannedThrough,
    input.through,
  );
  return { threadId: mirror.threadId, profileDemands };
}
