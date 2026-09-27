import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import type { ThreadContentLock } from '../common/locks/thread-content-lock.js';
import { lockAccountFeedAllocatorsInTx } from '../common/locks/account-feed-allocator-lock.js';

export interface P2PMessageProfileProjection {
  threadLock: ThreadContentLock;
  account: string;
  domain: string;
  namespaceId: number;
  messageSeq: number;
  profileRev: number;
}

export interface P2PMessageProfileProjectionChange {
  accountId: number;
  threadFeedId: number;
}

/** Post-fetch P2P projection from one committed message coordinate. The exact
 * snapshot is already durable; this transaction only publishes the selected
 * peer profile source to local thread-feed state. */
export async function projectP2PMessageProfileInTx(
  tx: DatabaseTransaction,
  projection: P2PMessageProfileProjection,
): Promise<P2PMessageProfileProjectionChange[]> {
  const { threadLock, account, domain, namespaceId, messageSeq, profileRev } =
    projection;
  if (
    !Number.isSafeInteger(messageSeq) ||
    messageSeq < 1 ||
    !Number.isSafeInteger(namespaceId) ||
    namespaceId < 0 ||
    !Number.isSafeInteger(profileRev) ||
    profileRev < 1
  )
    throw new RangeError('invalid committed P2P message profile coordinate');

  const participants = await tx.execute<{ accountId: number }>(sql`
    SELECT state."accountId" AS "accountId"
    FROM "AccountThreadState" state
    JOIN "Account" viewer ON viewer.id = state."accountId"
    JOIN "MessageThread" thread ON thread.id = state."threadId"
    JOIN "RelationshipPair" pair ON pair."threadId" = thread.id
      AND pair.kind = 'P2P' AND pair.established AND pair.active
    WHERE state."threadId" = ${threadLock.threadId}
      AND thread.type = 'P2P'
      AND state.blocked = false
      AND NOT (viewer.account = ${account} AND viewer.domain = ${domain})
      AND ((pair."endpointAType" = 'USER'
          AND pair."endpointAAccount" = viewer.account
          AND pair."endpointADomain" = viewer.domain)
        OR (pair."endpointBType" = 'USER'
          AND pair."endpointBAccount" = viewer.account
          AND pair."endpointBDomain" = viewer.domain))
    ORDER BY state."accountId"
  `);
  await lockAccountFeedAllocatorsInTx(
    tx,
    participants.rows.map((row) => row.accountId),
  );

  const changed = await tx.execute<{
    accountId: number;
    threadFeedId: number;
  }>(sql`
    WITH evidence AS (
      SELECT 1
      FROM "Message" message
      JOIN "MessageThread" thread ON thread.id = message."threadId"
      WHERE message."threadId" = ${threadLock.threadId}
        AND message.seq = ${messageSeq}
        AND thread.type = 'P2P'
        AND message."creatorAccount" = ${account}
        AND message."creatorDomain" = ${domain}
        AND message."creatorNamespaceId" = ${namespaceId}
        AND message."profileRev" = ${profileRev}
        AND message."contentType" <> 'SYSTEM'
        AND message."localState" = 'READY'
        AND NOT message."isDeleted"
        AND EXISTS (
          SELECT 1 FROM "Profile" profile
          WHERE profile.account = message."creatorAccount"
            AND profile.domain = message."creatorDomain"
            AND profile."namespaceId" = message."creatorNamespaceId"
            AND profile."profileRev" = ${profileRev}
        )
        AND NOT EXISTS (
          SELECT 1 FROM "Message" newer
          WHERE newer."threadId" = message."threadId"
            AND newer.seq > message.seq
            AND newer."creatorAccount" = message."creatorAccount"
            AND newer."creatorDomain" = message."creatorDomain"
            AND newer."creatorNamespaceId" = message."creatorNamespaceId"
            AND newer."contentType" <> 'SYSTEM'
            AND newer."localState" = 'READY'
            AND NOT newer."isDeleted"
        )
      LIMIT 1
    ), participants AS (
      SELECT state.id, state."accountId"
      FROM "AccountThreadState" state
      JOIN "Account" viewer ON viewer.id = state."accountId"
      JOIN "RelationshipPair" pair ON pair."threadId" = state."threadId"
        AND pair.kind = 'P2P' AND pair.established AND pair.active
      WHERE state."threadId" = ${threadLock.threadId}
        AND state.blocked = false
        AND NOT (viewer.account = ${account} AND viewer.domain = ${domain})
        AND ((pair."endpointAType" = 'USER'
            AND pair."endpointAAccount" = viewer.account
            AND pair."endpointADomain" = viewer.domain)
          OR (pair."endpointBType" = 'USER'
            AND pair."endpointBAccount" = viewer.account
            AND pair."endpointBDomain" = viewer.domain))
    )
    UPDATE "AccountThreadState" state
    SET "threadProfileRev" = ${profileRev},
      "profileSourceId" = ${messageSeq},
      "updatedAt" = CURRENT_TIMESTAMP
    FROM participants, evidence
    WHERE state.id = participants.id
      AND (state."profileSourceId" IS NULL OR state."profileSourceId" < ${messageSeq})
      AND state."threadProfileRev" IS DISTINCT FROM ${profileRev}
    RETURNING state."accountId" AS "accountId", state."threadFeedId" AS "threadFeedId"
  `);
  return changed.rows;
}
