import { sql } from 'drizzle-orm';
import type { ThreadContentLock } from '../common/locks/thread-content-lock.js';

type AuthorizedSourceHead = {
  messageEndSeq: number;
  tombstoneEndSeq: number;
  reverseEnabled: boolean;
};

/** Read the retained relationship authorization while its thread lock is held. */
export async function readAuthorizedSourceHeadInTx(
  lock: ThreadContentLock,
  namespaceId: number,
): Promise<AuthorizedSourceHead | undefined> {
  const result = await lock.tx.execute<AuthorizedSourceHead>(sql`
    SELECT DISTINCT ON (source."authorNamespaceId")
      intent."messageEndSeq", intent."tombstoneEndSeq",
      (thread.type = 'P2P' OR thread."authorityNamespaceId" > 0) AS "reverseEnabled"
    FROM "RelationshipPair" pair
    JOIN "MessageThread" thread ON thread.id = pair."threadId"
    CROSS JOIN LATERAL (VALUES
      (pair."endpointAAccount", pair."endpointANamespaceId",
        pair."endpointBAccount", pair."endpointBNamespaceId"),
      (pair."endpointBAccount", pair."endpointBNamespaceId",
        pair."endpointAAccount", pair."endpointANamespaceId")
    ) source("authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId")
    JOIN "RelationshipIntent" intent
      ON intent."authorAccount" = source."authorAccount"
        AND intent."authorNamespaceId" = source."authorNamespaceId"
        AND intent."receiverAccount" = source."receiverAccount"
        AND intent."receiverNamespaceId" = source."receiverNamespaceId"
    WHERE pair."threadId" = ${lock.threadId} AND pair.active = true
      AND source."authorNamespaceId" = ${namespaceId}
      AND (intent.status = 'ACCEPTED' OR
        (intent.status = 'REQUESTED' AND intent."expiresAt" > CURRENT_TIMESTAMP))
    ORDER BY source."authorNamespaceId", intent."updatedAt" DESC,
      intent."authorAccount", intent."receiverAccount"
    LIMIT 1
  `);
  return result.rows[0];
}
