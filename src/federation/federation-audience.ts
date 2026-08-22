import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  federationMessageFeedIndex,
  federationServeCursor,
  federationTombstoneFeedIndex,
  messageThread,
  threadAudience,
} from '../database/schema.js';

const DRAIN_BATCH = 500;

/**
 * Materialize all currently committed, eligible messages after an audience's durable thread scan
 * position. One scan advancement allocates at most one new compacted feed ID for the thread.
 */
export async function advanceFederatedAudienceInTx(
  tx: DatabaseTransaction,
  peerDomain: string,
  threadId: number,
): Promise<boolean> {
  const [audience] = await tx
    .select({
      id: threadAudience.id,
      scannedThrough: threadAudience.messageScannedThroughSeq,
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
  let scanned = audience.scannedThrough ?? thread.curSeq;
  let messageEndSeq: number | null = null;

  while (scanned < thread.curSeq) {
    const rows = await tx.execute<{
      messageId: string;
      messageSeq: number;
      eligible: boolean;
    }>(sql`
      SELECT target.id::text AS "messageId", target.seq AS "messageSeq",
             target."contentType" <> 'SYSTEM' AS eligible
      FROM "Message" target
      JOIN "MessageThread" thread ON thread.id = target."threadId"
      WHERE target."threadId" = ${threadId}
        AND target.seq > ${scanned}
        AND target.seq <= ${thread.curSeq}
      ORDER BY target.seq
      LIMIT ${DRAIN_BATCH}
    `);
    if (rows.rows.length === 0) {
      scanned = thread.curSeq;
      break;
    }
    const eligible = rows.rows.filter((row) => row.eligible);
    if (eligible.length > 0) messageEndSeq = eligible.at(-1)!.messageSeq;
    scanned = rows.rows.at(-1)!.messageSeq;
  }

  await tx
    .update(threadAudience)
    .set({ messageScannedThroughSeq: scanned })
    .where(eq(threadAudience.id, audience.id));

  if (messageEndSeq === null) return false;
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
      messageScannedThroughSeq: thread.curSeq,
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
