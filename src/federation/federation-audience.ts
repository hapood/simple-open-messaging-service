import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  federationMessageFeedAllocation,
  federationMessageDelivery,
  federationServeCursor,
  messageThread,
  threadAudience,
} from '../database/schema.js';

const DRAIN_BATCH = 500;

/** Start a new current authorization at the thread's committed end. The audience row is the
 * serialization point; message writers do not take or wait for this lock. */
export async function openFederatedAudienceInTx(
  tx: DatabaseTransaction,
  peerDomain: string,
  threadId: number,
): Promise<void> {
  await tx
    .select({ id: threadAudience.id })
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
      deliverThroughChangeId: null,
      messageScannedThroughSeq: thread.curSeq,
    })
    .onConflictDoUpdate({
      target: [threadAudience.targetDomain, threadAudience.threadId],
      targetWhere: sql`${threadAudience.targetDomain} <> 'local'`,
      set: {
        deliverThroughChangeId: null,
        messageScannedThroughSeq: thread.curSeq,
      },
    });
}

/** Freeze the audience first, then drain through the thread seq visible at that point. An uncommitted
 * message is linearized after close and message writers never wait for this operation. */
export async function closeFederatedAudienceInTx(
  tx: DatabaseTransaction,
  peerDomain: string,
  threadId: number,
): Promise<bigint> {
  const [audience] = await tx
    .select({
      id: threadAudience.id,
      scannedThrough: threadAudience.messageScannedThroughSeq,
      closedAt: threadAudience.deliverThroughChangeId,
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
  if (!audience) {
    const [cursor] = await tx
      .select({ endId: federationServeCursor.allocatedThrough })
      .from(federationServeCursor)
      .where(eq(federationServeCursor.peerDomain, peerDomain))
      .limit(1);
    if (!cursor) throw new Error(`peer ${peerDomain} has no message feed cursor`);
    return cursor.endId;
  }
  if (audience.closedAt !== null) return audience.closedAt;
  const [thread] = await tx
    .select({ curSeq: messageThread.curSeq })
    .from(messageThread)
    .where(eq(messageThread.id, threadId))
    .limit(1);
  if (!thread) throw new Error(`thread ${threadId} does not exist`);
  if (audience.scannedThrough === null)
    throw new Error(`peer audience ${audience.id.toString()} has no scan position`);
  let scanned = audience.scannedThrough;
  while (scanned < thread.curSeq) {
    const rows = await tx.execute<{
      messageId: string;
      messageSeq: number;
      eligible: boolean;
    }>(sql`
      SELECT target.id::text AS "messageId", target.seq AS "messageSeq",
             (
               target."contentType" <> 'SYSTEM'
               AND NOT (
                 thread.type = 'GROUP'
                 AND group_user.domain <> 'local'
                 AND (creator."isForeigner" OR target."originSeq" IS NOT NULL)
               )
             ) AS eligible
      FROM "Message" target
      JOIN "MessageThread" thread ON thread.id = target."threadId"
      JOIN "User" creator ON creator.id = target.creator
      LEFT JOIN "User" group_user ON group_user.id = thread."groupUserId"
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
    const candidates = rows.rows.filter((row) => row.eligible);
    if (candidates.length > 0) {
      const [allocated] = await tx
        .update(federationServeCursor)
        .set({
          allocatedThrough: sql`${federationServeCursor.allocatedThrough} + ${candidates.length}`,
          updatedAt: new Date(),
        })
        .where(eq(federationServeCursor.peerDomain, peerDomain))
        .returning({ last: federationServeCursor.allocatedThrough });
      if (!allocated)
        throw new Error(`peer ${peerDomain} has no message feed cursor`);
      const first = allocated.last - BigInt(candidates.length) + 1n;
      await tx.insert(federationMessageFeedAllocation).values(
        candidates.map((row, index) => ({
          peerDomain,
          feedId: first + BigInt(index),
          messageId: BigInt(row.messageId),
          threadId,
          messageSeq: row.messageSeq,
        })),
      );
      await tx
        .insert(federationMessageDelivery)
        .values(
          candidates.map((row) => ({
            peerDomain,
            messageId: BigInt(row.messageId),
          })),
        )
        .onConflictDoNothing();
    }
    scanned = rows.rows.at(-1)!.messageSeq;
    await tx
      .update(threadAudience)
      .set({ messageScannedThroughSeq: scanned })
      .where(eq(threadAudience.id, audience.id));
  }
  const [cursor] = await tx
    .select({ endId: federationServeCursor.allocatedThrough })
    .from(federationServeCursor)
    .where(eq(federationServeCursor.peerDomain, peerDomain))
    .limit(1);
  if (!cursor) throw new Error(`peer ${peerDomain} has no message feed cursor`);
  await tx
    .update(threadAudience)
    .set({
      messageScannedThroughSeq: scanned,
      deliverThroughChangeId: cursor.endId,
    })
    .where(eq(threadAudience.id, audience.id));
  return cursor.endId;
}
