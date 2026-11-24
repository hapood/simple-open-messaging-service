import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../common/locks/thread-content-lock.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

type AuthorizedSourceHead = {
  messageEndSeq: number;
  tombstoneEndSeq: number;
  reverseEnabled: boolean;
};

/** Align one remote source from the retained authorization snapshot.
 * Relationship activation and each message round call this; neither owns a
 * separate initialization. */
export async function prepareFederationMessageRoundInTx(
  tx: DatabaseTransaction,
  threadId: number,
  namespaceId: number,
  held?: ThreadContentLock,
): Promise<void> {
  if (namespaceId <= 0) return;
  const threadLock = await requireThreadContentLockInTx(tx, threadId, held);
  const head = await readAuthorizedSourceHeadInTx(tx, threadId, namespaceId);
  if (!head) return;
  await FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
    tx,
    {
      threadId,
      namespaceId,
      messageTargetSeq: head.messageEndSeq,
      deletionTargetSeq: head.tombstoneEndSeq,
      reverseEnabled: head.reverseEnabled,
      threadLock,
    },
  );
}

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
    await prepareFederationMessageRoundInTx(
      tx,
      threadId,
      source.namespaceId,
      threadLock,
    );
}

async function readAuthorizedSourceHeadInTx(
  tx: DatabaseTransaction,
  threadId: number,
  namespaceId: number,
): Promise<AuthorizedSourceHead | undefined> {
  const result = await tx.execute<AuthorizedSourceHead>(sql`
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
    WHERE pair."threadId" = ${threadId} AND pair.active = true
      AND source."authorNamespaceId" = ${namespaceId}
      AND (intent.status = 'ACCEPTED' OR
        (intent.status = 'REQUESTED' AND intent."expiresAt" > CURRENT_TIMESTAMP))
    ORDER BY source."authorNamespaceId", intent."updatedAt" DESC,
      intent."authorAccount", intent."receiverAccount"
    LIMIT 1
  `);
  return result.rows[0];
}
