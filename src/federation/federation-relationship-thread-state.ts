import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../common/locks/thread-content-lock.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

/** Activate each remote source from its retained authored authorization snapshot. */
export async function initializeRelationshipThreadStateInTx(
  tx: DatabaseTransaction,
  threadId: number,
  pairId: bigint,
  held?: ThreadContentLock,
): Promise<void> {
  const threadLock = await requireThreadContentLockInTx(tx, threadId, held);
  const result = await tx.execute<{
    namespaceId: number;
    messageEndSeq: number;
    tombstoneEndSeq: number;
    reverseEnabled: boolean;
  }>(sql`
    SELECT DISTINCT ON (source."namespaceId") source."namespaceId",
      intent."messageEndSeq", intent."tombstoneEndSeq",
      (thread.type = 'P2P' OR thread."groupDomain" <> 'local') AS "reverseEnabled"
    FROM "RelationshipPair" pair
    JOIN "MessageThread" thread ON thread.id = pair."threadId"
    CROSS JOIN LATERAL (VALUES
      ('A', pair."endpointADomain", pair."endpointANamespaceId"),
      ('B', pair."endpointBDomain", pair."endpointBNamespaceId")
    ) source(side, domain, "namespaceId")
    JOIN "RelationshipIntent" intent
      ON intent."pairId" = pair.id AND intent."authorSide" = source.side
    WHERE pair.id = ${pairId} AND pair."threadId" = ${threadId} AND pair.active = true
      AND source.domain <> 'local'
      AND (intent.status = 'ACCEPTED' OR
        (intent.status = 'REQUESTED' AND intent."expiresAt" > CURRENT_TIMESTAMP))
    ORDER BY source."namespaceId", intent."updatedAt" DESC, intent.id DESC
  `);
  for (const head of result.rows) {
    await FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
      tx,
      {
        threadId,
        namespaceId: head.namespaceId,
        messageTargetSeq: head.messageEndSeq,
        deletionTargetSeq: head.tombstoneEndSeq,
        reverseEnabled: head.reverseEnabled,
        threadLock,
      },
    );
  }
}
