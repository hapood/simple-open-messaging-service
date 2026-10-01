import { sql, type SQL } from 'drizzle-orm';
import { isGroupAccount } from '../../../common/account.js';

/** Flips the shared request projection after a membership decision. The caller
 * owns the group and relationship business locks. No feed position is allocated. */
type RequestProjectionFlipParams = {
  threadId: number;
  memberAccount: string;
  profileNamespaceId: number;
  directions: readonly ('APPLICATION' | 'INVITATION')[];
} & (
  | { status: 'ACCEPTED'; authorAccount?: never }
  /** REVOKED is the relationship-intent decision. For projections it is
   * translated to a direction-specific terminal status below: the author's own
   * direction withdraws, the other side rejects. The `!` sigil decides which
   * endpoint authored the decision. */
  | { status: 'REVOKED'; authorAccount: string }
);

export function requestProjectionFlipSql(
  params: RequestProjectionFlipParams,
): SQL {
  const authorIsGroup =
    params.status === 'REVOKED' && isGroupAccount(params.authorAccount);
  return sql`
    manager_requests AS MATERIALIZED (
      SELECT r.*
      FROM "GroupRequestProjection" r
      WHERE r."threadId" = ${params.threadId} AND r."memberAccount" = ${params.memberAccount}
        AND r."profileNamespaceId" = ${params.profileNamespaceId}
        AND r.direction = ANY(${sql.param(params.directions)}::text[])
        -- Only an outstanding request can be decided. Terminal projection
        -- states, including ACCEPTED, survive later convergence passes. A
        -- new REQUESTED projection is written by the request SQL and
        -- deliberately resets this row before this fragment runs again.
        AND r.status = 'REQUESTED'
    ), request_projection AS (
      UPDATE "GroupRequestProjection" r SET status = (CASE
        WHEN ${params.status} = 'REVOKED'
          THEN CASE
            WHEN ((${authorIsGroup} AND r.direction = 'INVITATION')
              OR (NOT ${authorIsGroup} AND r.direction = 'APPLICATION'))
              THEN 'WITHDRAWN' ELSE 'REJECTED' END
          ELSE ${params.status}
        END)::"RequestProjectionStatus"
      FROM manager_requests p
      WHERE r."threadId" = p."threadId" AND r."memberAccount" = p."memberAccount"
        AND r."profileNamespaceId" = p."profileNamespaceId" AND r.direction = p.direction
      RETURNING 1
    )`;
}
