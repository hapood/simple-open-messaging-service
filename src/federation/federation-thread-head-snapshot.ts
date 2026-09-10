import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';

export interface ThreadHeadSnapshot extends Record<string, unknown> {
  messageEndSeq: number;
  tombstoneEndSeq: number;
}

/** Both coordinates use one statement snapshot, including under READ COMMITTED. */
export async function readThreadHeadSnapshotInTx(
  tx: DatabaseTransaction,
  threadId: number | null,
  messageAccessAfterSeq = 0,
): Promise<ThreadHeadSnapshot> {
  if (threadId === null) return { messageEndSeq: 0, tombstoneEndSeq: 0 };
  const result = await tx.execute<ThreadHeadSnapshot>(sql`
    SELECT COALESCE((
      SELECT MAX(m.seq) FROM "Message" m
      WHERE m."threadId" = ${threadId}
        AND m.seq > ${messageAccessAfterSeq} AND m."contentType" <> 'SYSTEM'
    ), ${messageAccessAfterSeq}) AS "messageEndSeq",
    COALESCE((
      SELECT MAX(d."deletionSeq") FROM "DeletedMessage" d
      JOIN "Message" m ON m."threadId" = d."threadId" AND m.seq = d."messageSeq"
      WHERE d."threadId" = ${threadId} AND d."sourceNamespaceId" = 0
    ), 0) AS "tombstoneEndSeq"
  `);
  if (!result.rows[0]) throw new Error('thread head snapshot missing');
  return result.rows[0];
}
