import { sql, type SQL } from 'drizzle-orm';

export interface MemberMembershipRequestStateInput {
  threadId: number;
  pairId: bigint;
  groupAccount: string;
  groupProfileRev: number;
  memberAccount: string;
  profileNamespaceId: number;
  localMemberId: number | null;
  note: string;
  statusChangedAt: Date;
  expiresAt: Date;
}

/** Member-authored protocol state only. Request rounds and notification heads
 * must be coordinated by the owning request capability in the same transaction;
 * they are no longer reconstructed from client intent events. */
export function memberMembershipRequestStatement(
  input: MemberMembershipRequestStateInput,
  intentWrite: SQL,
): SQL {
  return sql`
    WITH authored AS (
      ${intentWrite}
    ), request_state AS MATERIALIZED (
      SELECT status, "profileRev", note, "statusChangedAt", "expiresAt" FROM authored
      UNION ALL
      SELECT status, "profileRev", note, "statusChangedAt", "expiresAt"
      FROM "RelationshipIntent"
      WHERE "authorAccount" = ${input.memberAccount} AND "authorNamespaceId" = ${input.profileNamespaceId}
        AND "receiverAccount" = ${input.groupAccount} AND "receiverNamespaceId" = 0
        AND NOT EXISTS (SELECT 1 FROM authored)
    )
    SELECT v.status, v.note,
      EXISTS (SELECT 1 FROM authored) AS "intentChanged"
    FROM request_state v
  `;
}
