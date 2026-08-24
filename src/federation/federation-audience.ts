import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  federationMessageFeedIndex,
  federationServeCursor,
  federationTombstoneFeedIndex,
  messageThread,
  threadAudience,
} from '../database/schema.js';

/**
 * Materialize the newest currently committed, eligible message above the audience's access floor.
 * The compacted feed index is itself the durable discovery position, so no second scan cursor is stored.
 */
export async function advanceFederatedAudienceInTx(
  tx: DatabaseTransaction,
  peerDomain: string,
  threadId: number,
): Promise<boolean> {
  const [audience] = await tx
    .select({
      id: threadAudience.id,
      messageAccessAfterSeq: threadAudience.messageAccessAfterSeq,
    })
    .from(threadAudience)
    .where(
      and(
        eq(threadAudience.targetDomain, peerDomain),
        eq(threadAudience.threadId, threadId),
        isNull(threadAudience.localUserId),
      ),
    )
    .for('update')
    .limit(1);
  if (!audience) return false;

  const [thread] = await tx
    .select({ curSeq: messageThread.curSeq })
    .from(messageThread)
    .where(eq(messageThread.id, threadId))
    .limit(1);
  if (!thread) throw new Error(`thread ${threadId} does not exist`);
  const latest = await tx.execute<{ messageEndSeq: number }>(sql`
    SELECT target.seq AS "messageEndSeq"
    FROM "Message" target
    WHERE target."threadId" = ${threadId}
      AND target.seq > ${audience.messageAccessAfterSeq}
      AND target.seq <= ${thread.curSeq}
      AND target."contentType" <> 'SYSTEM'
    ORDER BY target.seq DESC
    LIMIT 1
  `);
  const messageEndSeq = latest.rows[0]?.messageEndSeq;
  if (messageEndSeq === undefined) return false;
  const [current] = await tx
    .select({ messageEndSeq: federationMessageFeedIndex.messageEndSeq })
    .from(federationMessageFeedIndex)
    .where(
      and(
        eq(federationMessageFeedIndex.peerDomain, peerDomain),
        eq(federationMessageFeedIndex.threadId, threadId),
      ),
    )
    .limit(1);
  if (current && current.messageEndSeq >= messageEndSeq) return false;

  const [head] = await tx
    .update(federationServeCursor)
    .set({
      allocatedThrough: sql`${federationServeCursor.allocatedThrough} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(federationServeCursor.peerDomain, peerDomain))
    .returning({ feedId: federationServeCursor.allocatedThrough });
  if (!head) throw new Error(`peer ${peerDomain} has no message feed target`);
  await tx
    .insert(federationMessageFeedIndex)
    .values({ peerDomain, threadId, feedId: head.feedId, messageEndSeq })
    .onConflictDoUpdate({
      target: [
        federationMessageFeedIndex.peerDomain,
        federationMessageFeedIndex.threadId,
      ],
      set: {
        feedId: head.feedId,
        messageEndSeq,
        updatedAt: new Date(),
      },
    });
  return true;
}

/** Open directional peer query access. Repeated REQUESTED/ACCEPTED writes are idempotent and never
 * move the audience scan position backwards. A newly authorized audience starts at the current
 * thread boundary, so first authorization and reauthorization cannot expose an unauthorized gap. */
export async function openFederatedAudienceInTx(
  tx: DatabaseTransaction,
  peerDomain: string,
  threadId: number,
): Promise<void> {
  const [thread] = await tx
    .select({ curSeq: messageThread.curSeq })
    .from(messageThread)
    .where(eq(messageThread.id, threadId))
    .limit(1);
  if (!thread) throw new Error(`thread ${threadId} does not exist`);
  await tx
    .insert(threadAudience)
    .values({
      targetDomain: peerDomain,
      localUserId: null,
      threadId,
      messageAccessAfterSeq: thread.curSeq,
    })
    .onConflictDoNothing({
      target: [threadAudience.targetDomain, threadAudience.threadId],
      where: sql`${threadAudience.targetDomain} <> 'local'`,
    });
}

/** Close the current audience and remove both independently compacted discovery projections. */
export async function closeFederatedAudienceInTx(
  tx: DatabaseTransaction,
  peerDomain: string,
  threadId: number,
): Promise<void> {
  await tx
    .delete(threadAudience)
    .where(
      and(
        eq(threadAudience.targetDomain, peerDomain),
        eq(threadAudience.threadId, threadId),
        isNull(threadAudience.localUserId),
      ),
    );
  await tx
    .delete(federationMessageFeedIndex)
    .where(
      and(
        eq(federationMessageFeedIndex.peerDomain, peerDomain),
        eq(federationMessageFeedIndex.threadId, threadId),
      ),
    );
  await tx
    .delete(federationTombstoneFeedIndex)
    .where(
      and(
        eq(federationTombstoneFeedIndex.peerDomain, peerDomain),
        eq(federationTombstoneFeedIndex.threadId, threadId),
      ),
    );
}
