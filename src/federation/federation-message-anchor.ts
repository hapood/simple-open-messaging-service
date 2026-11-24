import { sql } from 'drizzle-orm';
import type { ThreadContentLock } from '../common/locks/thread-content-lock.js';

/** Dynamically resolve the highest covered publisher seq under the thread lock. */
export async function resolvePublisherCoverageInTx(
  lock: ThreadContentLock,
  namespaceId: number,
): Promise<{ coveredThroughSeq: number }> {
  const messageResult = await lock.tx.execute<{ maxOriginSeq: number }>(sql`
    SELECT COALESCE(MAX("originSeq"), 0)::integer AS "maxOriginSeq"
    FROM "Message"
    WHERE "threadId" = ${lock.threadId}
      AND "publisherNamespaceId" = ${namespaceId}
      AND "publisherNamespaceId" <> 0
      AND "originSeq" IS NOT NULL
  `);
  const gapResult = await lock.tx.execute<{ maxEndSeq: number }>(sql`
    SELECT COALESCE(MAX("endSeq"), 0)::integer AS "maxEndSeq"
    FROM "FederationThreadHistoryGap"
    WHERE "threadId" = ${lock.threadId} AND "namespaceId" = ${namespaceId}
  `);
  const maxOriginSeq = messageResult.rows[0]?.maxOriginSeq ?? 0;
  const maxGapEndSeq = gapResult.rows[0]?.maxEndSeq ?? 0;
  return {
    coveredThroughSeq: Math.max(maxOriginSeq, maxGapEndSeq),
  };
}
