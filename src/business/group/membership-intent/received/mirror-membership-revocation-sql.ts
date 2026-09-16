import { sql, type SQL } from 'drizzle-orm';
import { clientIntentFeedWriteSql } from '../../../shared/sql/relationship-intent-recipient-feed-sql.js';
import {
  epochMillisSql,
  mirrorIntentCompactionKey,
  mirrorIntentFeedBodySql,
  mirrorIntentReadBackSql,
  mirrorIntentWriteSql,
  type MirrorGroupPresentationInput,
} from './mirror-membership-shared-sql.js';

export interface MirrorMembershipRevocationInput {
  threadId: number;
  pairId: bigint;
  presentation: MirrorGroupPresentationInput;
  memberAccount: string;
  localMemberId: number;
}

/** Persist received side A REVOKED, deactivate an active pair, and publish the
 * invitee's feed row. The epoch advances only when the last active local pair
 * leaves. The caller writes the local GROUP_LEFT and its readable boundary
 * when the pair changed, then concludes an effective side B intent. This
 * statement writes no Group Meta fact. */
export function mirrorMembershipRevocationSql(
  input: MirrorMembershipRevocationInput,
): SQL {
  return sql`
    WITH authored AS (
      ${mirrorIntentWriteSql({
        pairId: input.pairId,
        authorSide: 'A',
        status: 'REVOKED',
        note: '',
        requestedAt: null,
        expiresAt: null,
        profileRev: 0,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
      })}
    ), ${mirrorIntentReadBackSql({
      writeName: 'authored',
      readBackName: 'persisted_intent',
      pairId: input.pairId,
      authorSide: 'A',
    })}, pair_change AS (
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
            AND remaining."endpointAType" = 'GROUP'
            AND remaining."endpointAAccount" = ${input.presentation.groupAccount}
            AND remaining."endpointADomain" = ${input.presentation.groupDomain}
            AND remaining."endpointBType" = 'USER'
            AND remaining."endpointBDomain" = 'local'
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
    ), candidate_bodies AS MATERIALIZED (
      SELECT ${input.localMemberId}::integer AS "userId",
        ${input.presentation.groupNamespaceId}::integer AS "namespaceId", 1 AS ordinal,
        ${mirrorIntentCompactionKey({
          groupNamespaceId: input.presentation.groupNamespaceId,
          groupAccount: input.presentation.groupAccount,
          groupDomain: input.presentation.groupDomain,
          memberAccount: input.memberAccount,
        })}::text AS "compactionKey",
        ${input.presentation.groupAccount}::text AS account,
        ${input.presentation.groupDomain}::text AS domain,
        ${input.memberAccount}::text AS "subjectAccount", 'local'::text AS "subjectDomain",
        ${mirrorIntentFeedBodySql({
          status: sql`v.status`,
          note: sql`v.note`,
          requestedAt: epochMillisSql(sql`v."requestedAt"`),
          expiresAt: epochMillisSql(sql`v."expiresAt"`),
          established: sql`(SELECT p.established FROM "RelationshipPair" p
            WHERE p.id = ${input.pairId})`,
          threadId: input.threadId,
          presentation: input.presentation,
        })} AS body
      FROM persisted_intent v
    ), ${clientIntentFeedWriteSql()}
    SELECT EXISTS (SELECT 1 FROM authored) AS "intentChanged",
      EXISTS (SELECT 1 FROM pair_change) AS "pairChanged",
      EXISTS (SELECT 1 FROM epoch_bump) AS "epochChanged",
      (SELECT "userId" FROM recipient_result) AS "recipientUserId",
      (SELECT "feedId" FROM recipient_result) AS "recipientFeedId"
    FROM persisted_intent v
  `;
}
