import { sql, type SQL } from 'drizzle-orm';
import {
  mirrorGroupDirection,
  mirrorIntentWriteSql,
  type MirrorGroupPresentationInput,
} from './mirror-membership-shared-sql.js';

export interface MirrorMembershipRevocationInput {
  threadId: number;
  pairId: bigint;
  presentation: MirrorGroupPresentationInput;
  memberAccount: string;
  localMemberId: number;
  requestStatus?: 'WITHDRAWN' | 'REJECTED';
  requestDirection?: 'INCOMING' | 'OUTGOING';
}

/** The received side A REVOKED wire write, run before the domain statement in
 * the owning transaction. Its guarded RETURNING reports whether this delivery
 * actually moved the mirrored group direction. */
export function mirrorMembershipRevocationIntentWrite(
  input: MirrorMembershipRevocationInput & { statusChangedAt: Date },
): SQL {
  const { author, receiver } = mirrorGroupDirection(
    input.presentation,
    input.memberAccount,
  );
  return mirrorIntentWriteSql({
    author,
    receiver,
    status: 'REVOKED',
    note: '',
    statusChangedAt: input.statusChangedAt,
    expiresAt: null,
    profileNamespaceId: 0,
    profileRev: 0,
    messageEndSeq: 0,
    tombstoneEndSeq: 0,
  });
}

/** Deactivate an active pair under the persisted side A REVOKED. The epoch
 * advances only when the last active local pair leaves. The caller writes the
 * local GROUP_LEFT and its readable boundary when the pair changed, then
 * concludes an effective side B intent. This statement writes no Group Meta
 * fact. */
export function mirrorMembershipRevocationSql(
  input: MirrorMembershipRevocationInput,
): SQL {
  const { author, receiver } = mirrorGroupDirection(
    input.presentation,
    input.memberAccount,
  );
  return sql`
    WITH persisted_intent AS MATERIALIZED (
      SELECT status
      FROM "RelationshipIntent"
      WHERE "authorAccount" = ${author.account} AND "authorNamespaceId" = ${author.namespaceId}
        AND "receiverAccount" = ${receiver.account} AND "receiverNamespaceId" = ${receiver.namespaceId}
    ), pair_change AS (
      UPDATE "RelationshipPair" SET active = false, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${input.pairId} AND active IS DISTINCT FROM false
      RETURNING id
    ), epoch_bump AS (
      UPDATE "MessageThread" t
        SET "authorizationEpoch" = t."authorizationEpoch" + 1, "federationRoundsEnabled" = false,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE t.id = ${input.threadId} AND EXISTS (SELECT 1 FROM pair_change)
        AND NOT EXISTS (
          SELECT 1 FROM "RelationshipPair" remaining
          WHERE remaining."threadId" = ${input.threadId}
            AND remaining.kind = 'GROUP_MEMBER' AND remaining.active
            AND remaining."endpointBType" = 'GROUP'
            AND remaining."endpointBAccount" = ${input.presentation.groupAccount}
            AND remaining."endpointBNamespaceId" = ${input.presentation.groupNamespaceId}
            AND remaining."endpointAType" = 'USER'
            AND remaining.id <> ${input.pairId}
        )
      RETURNING t.id
    ), meta_reset AS (
      -- The last local member left: the applied roster is stale by definition.
      -- A zero processed cursor with a closed window re-selects a full
      -- snapshot on re-activation.
      UPDATE "GroupMeta" f
        SET "metaTargetId" = 0, "metaProcessedThroughId" = 0,
          "metaRecoveryThroughId" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      FROM epoch_bump WHERE f."threadId" = epoch_bump.id
      RETURNING f."threadId"
    )
    SELECT
      EXISTS (SELECT 1 FROM pair_change) AS "pairChanged",
      EXISTS (SELECT 1 FROM epoch_bump) AS "epochChanged"
    FROM persisted_intent v
  `;
}
