import { sql, type SQL } from 'drizzle-orm';

/** Flips the shared request projection after a membership decision. The caller
 * owns the group and relationship business locks. No feed position is allocated. */
type RequestProjectionFlipParams = {
  threadId: number;
  memberAccount: string;
  memberDomain: string;
  memberNamespaceId: number;
  directions: readonly ('APPLICATION' | 'INVITATION')[];
} & (
  | { status: 'ACCEPTED'; authorSide?: never }
  /** REVOKED is the relationship-intent decision. For projections it is
   * translated to a direction-specific terminal status below. */
  | { status: 'REVOKED'; authorSide: 'A' | 'B' }
);

export function requestProjectionFlipSql(
  params: RequestProjectionFlipParams,
): SQL {
  const authorSide = params.status === 'REVOKED' ? params.authorSide : null;
  return sql`
    manager_requests AS MATERIALIZED (
      SELECT r.*
      FROM "GroupRequestProjection" r
      WHERE r."threadId" = ${params.threadId} AND r."memberAccount" = ${params.memberAccount}
        AND r."memberDomain" = ${params.memberDomain} AND r."memberNamespaceId" = ${params.memberNamespaceId}
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
            WHEN ((${authorSide} = 'A' AND r.direction = 'INVITATION')
              OR (${authorSide} = 'B' AND r.direction = 'APPLICATION'))
              THEN 'WITHDRAWN' ELSE 'REJECTED' END
          ELSE ${params.status}
        END)::varchar(15)
      FROM manager_requests p
      WHERE r."threadId" = p."threadId" AND r."memberAccount" = p."memberAccount"
        AND r."memberDomain" = p."memberDomain" AND r."memberNamespaceId" = p."memberNamespaceId" AND r.direction = p.direction
      RETURNING 1
    )`;
}
