import { eq, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import {
  groupMeta,
  groupMetaMemberFeed,
  messageThread,
} from '../../database/schema.js';
import { enqueueThreadFanoutInTx } from '../../message/thread-fanout-task.js';
import { requireGroupThreadContentLockUnderGroupInTx } from '../../common/locks/thread-content-lock.js';
import { upsertCurrentGroupMetaFactsInTx } from './current-group-meta-fact.js';
import type {
  MirrorGroupAddress,
  MirrorMetaReplicatedItem,
} from './mirror-meta-shared.js';
import {
  advanceMirrorProcessedThroughInTx,
  currentMirrorMetaFact,
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
  await tx
    .delete(groupMetaMemberFeed)
    .where(eq(groupMetaMemberFeed.threadId, mirror.threadId));
  const facts = input.items.flatMap((item) => {
    if (item.operation === 'DEPART')
      throw new Error('a full group-meta snapshot cannot contain DEPART');
    return item.operation === 'GROUP_ANNOUNCEMENT'
      ? []
      : [currentMirrorMetaFact(mirror.threadId, input.group, item)];
  });
  await upsertCurrentGroupMetaFactsInTx(tx, facts);
  const announcement = input.items.find(
    (item) => item.operation === 'GROUP_ANNOUNCEMENT',
  );
  await tx
    .update(groupMeta)
    .set({
      announcementFeedId: announcement?.feedId ?? null,
      announcementText:
        announcement?.operation === 'GROUP_ANNOUNCEMENT'
          ? announcement.text
          : null,
      updatedAt: new Date(),
    })
    .where(eq(groupMeta.threadId, mirror.threadId));
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
  return { threadId: mirror.threadId };
}
