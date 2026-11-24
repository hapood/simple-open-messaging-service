import { and, eq, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { clientGroupMetaFeed } from '../../database/schema.js';
import {
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../../common/locks/thread-content-lock.js';
import { enqueueThreadMetaFanoutInTx } from '../../message/thread-fanout-task.js';

type ClientCopy = {
  operation: 'GROUP_ANNOUNCEMENT';
  sourceFeedId: number;
  originCreatedAt: Date | null;
  body: { text: string | null };
};

/** Write the client half of an announcement. Callers already hold the fact they
 * are authoring or applying; this does not scan the canonical feed.
 * The same or an older source coordinate allocates nothing. A newer source
 * coordinate allocates even when the visible value is unchanged. */
export async function publishClientGroupFactInTx(
  tx: DatabaseTransaction,
  threadLock: ThreadContentLock,
  fact: ClientCopy,
): Promise<{ changed: boolean; feedId: number }> {
  const threadId = threadLock.threadId;
  await requireThreadContentLockInTx(tx, threadId, threadLock);
  if (!Number.isSafeInteger(fact.sourceFeedId) || fact.sourceFeedId < 1)
    throw new Error('client group fact has no source coordinate');
  const locked = await tx.execute<{ threadId: number }>(sql`
    SELECT "threadId" FROM "GroupMeta" WHERE "threadId" = ${threadId}
    FOR NO KEY UPDATE
  `);
  if (!locked.rows[0]) throw new Error('group meta allocator is missing');
  const [current] = await tx
    .select({
      feedId: clientGroupMetaFeed.feedId,
      sourceFeedId: clientGroupMetaFeed.sourceFeedId,
    })
    .from(clientGroupMetaFeed)
    .where(
      and(
        eq(clientGroupMetaFeed.threadId, threadId),
        eq(clientGroupMetaFeed.operation, fact.operation),
      ),
    );
  if (current?.sourceFeedId != null && current.sourceFeedId >= fact.sourceFeedId)
    return { changed: false, feedId: current.feedId };

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
      operation: fact.operation,
      body: fact.body,
      sourceFeedId: fact.sourceFeedId,
      originCreatedAt: fact.originCreatedAt,
    })
    .onConflictDoUpdate({
      target: [clientGroupMetaFeed.threadId, clientGroupMetaFeed.operation],
      set: {
        feedId,
        body: fact.body,
        sourceFeedId: fact.sourceFeedId,
        originCreatedAt: fact.originCreatedAt,
        createdAt: sql`CURRENT_TIMESTAMP`,
      },
    });
  await enqueueThreadMetaFanoutInTx(tx, threadLock, {
    threadId,
    groupMetaFeedEndId: feedId,
  });
  return { changed: true, feedId };
}
