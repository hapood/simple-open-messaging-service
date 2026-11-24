import { and, eq, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { clientGroupMetaFeed } from '../../database/schema.js';
import {
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../../common/locks/thread-content-lock.js';
import { enqueueThreadMetaFanoutInTx } from '../../message/thread-fanout-task.js';

/** Reconcile once after the complete member batch, not once per member.
 * Caller owns a valid initialized roster and admits client meta fanout only on change. */
export async function reconcileClientMemberCountInTx(
  tx: DatabaseTransaction,
  threadLock: ThreadContentLock,
): Promise<{ changed: boolean; feedId: number; memberCount: number }> {
  const threadId = threadLock.threadId;
  await requireThreadContentLockInTx(tx, threadId, threadLock);
  const locked = await tx.execute<{ clientMetaEndId: number }>(sql`
    SELECT "clientMetaEndId" FROM "GroupMeta" WHERE "threadId" = ${threadId}
    FOR NO KEY UPDATE
  `);
  if (!locked.rows[0]) throw new Error('group meta allocator is missing');
  const result = await tx.execute<{ memberCount: number }>(sql`
    SELECT count(*)::integer AS "memberCount" FROM "GroupMetaMemberFeed"
    WHERE "threadId" = ${threadId} AND operation = 'MEMBER_UPSERT'
  `);
  const memberCount = result.rows[0]!.memberCount;
  const [current] = await tx
    .select()
    .from(clientGroupMetaFeed)
    .where(
      and(
        eq(clientGroupMetaFeed.threadId, threadId),
        eq(clientGroupMetaFeed.operation, 'GROUP_MEMBER_COUNT'),
      ),
    );
  if (
    current &&
    'memberCount' in current.body &&
    current.body.memberCount === memberCount
  )
    return { changed: false, feedId: current.feedId, memberCount };

  // Allocate only after comparing the final roster count, including explicit zero.
  const allocation = await tx.execute<{ feedId: number }>(sql`
    UPDATE "GroupMeta" SET "clientMetaEndId" = "clientMetaEndId" + 1,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "threadId" = ${threadId}
    RETURNING "clientMetaEndId" AS "feedId"
  `);
  const feedId = allocation.rows[0]!.feedId;
  await tx
    .insert(clientGroupMetaFeed)
    .values({
      threadId,
      feedId,
      operation: 'GROUP_MEMBER_COUNT',
      body: { memberCount },
    })
    .onConflictDoUpdate({
      target: [clientGroupMetaFeed.threadId, clientGroupMetaFeed.operation],
      set: { feedId, body: { memberCount }, createdAt: sql`CURRENT_TIMESTAMP` },
    });
  await enqueueThreadMetaFanoutInTx(tx, threadLock, {
    threadId,
    groupMetaFeedEndId: feedId,
  });
  return { changed: true, feedId, memberCount };
}
