import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../common/locks/thread-content-lock.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

/** Activate each remote source on a newly active pair through the shared prepare. */
export async function initializeRelationshipThreadStateInTx(
  tx: DatabaseTransaction,
  threadId: number,
  pairId: bigint,
  held?: ThreadContentLock,
): Promise<void> {
  const threadLock = await requireThreadContentLockInTx(tx, threadId, held);
  const sources = await tx.execute<{ namespaceId: number }>(sql`
    SELECT source."authorNamespaceId" AS "namespaceId"
    FROM "RelationshipPair" pair
    CROSS JOIN LATERAL (VALUES
      (pair."endpointANamespaceId"),
      (pair."endpointBNamespaceId")
    ) source("authorNamespaceId")
    WHERE pair.id = ${pairId} AND pair."threadId" = ${threadId} AND pair.active = true
      AND source."authorNamespaceId" > 0
  `);
  for (const source of sources.rows)
    await FederationThreadSyncStateService.prepareMessageRoundInTx(
      tx,
      threadId,
      source.namespaceId,
      threadLock,
    );
}
