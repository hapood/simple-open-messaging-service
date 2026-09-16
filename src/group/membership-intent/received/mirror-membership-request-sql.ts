import { sql, type SQL } from 'drizzle-orm';
import { clientIntentFeedWriteSql } from '../../../common/sql/relationship-intent-recipient-feed-sql.js';
import {
  epochMillisSql,
  mirrorIntentCompactionKey,
  mirrorIntentFeedBodySql,
  mirrorIntentReadBackSql,
  mirrorIntentWriteSql,
  type MirrorGroupPresentationInput,
} from './mirror-membership-shared-sql.js';

export interface MirrorMembershipRequestInput {
  threadId: number;
  /** Minted by the transaction owner's lock preamble when the pair is absent. */
  pairId: bigint;
  presentation: MirrorGroupPresentationInput;
  memberAccount: string;
  localMemberId: number;
  /** Wire coordinates from the received item body. */
  intent: {
    profileRev: number;
    note: string;
    requestedAt: Date;
    expiresAt: Date;
    messageEndSeq: number;
    tombstoneEndSeq: number;
  };
}

/** One composed statement for a received REQUESTED that does not activate: the
 * stranger branch (the preamble minted the inactive canonical pair, this
 * statement persists side A) and the refresh branch (side B REVOKED or expired
 * — side B stays untouched so re-application keeps working). Activating
 * collapses route to the acceptance statement instead. The invitee's only
 * artifact is the client feed row; a mirror owns no projections, meta facts,
 * or audience rows. */
export function mirrorMembershipRequestSql(
  input: MirrorMembershipRequestInput,
): SQL {
  return sql`
    WITH authored AS (
      ${mirrorIntentWriteSql({
        pairId: input.pairId,
        authorSide: 'A',
        status: 'REQUESTED',
        note: input.intent.note,
        requestedAt: input.intent.requestedAt,
        expiresAt: input.intent.expiresAt,
        profileRev: input.intent.profileRev,
        messageEndSeq: input.intent.messageEndSeq,
        tombstoneEndSeq: input.intent.tombstoneEndSeq,
      })}
    ), ${mirrorIntentReadBackSql({
      writeName: 'authored',
      readBackName: 'persisted_intent',
      pairId: input.pairId,
      authorSide: 'A',
    })}, candidate_bodies AS MATERIALIZED (
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
          established: sql`false`,
          threadId: input.threadId,
          presentation: input.presentation,
        })} AS body
      FROM persisted_intent v
    ), ${clientIntentFeedWriteSql()}
    SELECT EXISTS (SELECT 1 FROM authored) AS "intentChanged",
      (SELECT "userId" FROM recipient_result) AS "recipientUserId",
      (SELECT "feedId" FROM recipient_result) AS "recipientFeedId"
    FROM persisted_intent v
  `;
}
