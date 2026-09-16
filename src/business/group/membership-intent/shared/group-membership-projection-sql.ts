import { sql, type SQL } from 'drizzle-orm';

/** Flips the shared request projection after a membership decision. The caller
 * owns the group and relationship business locks. No feed position is allocated. */
export function requestProjectionFlipSql(params: {
  threadId: number;
  memberAccount: string;
  memberDomain: string;
  memberNamespaceId: number;
  status: 'ACCEPTED' | 'REVOKED';
  directions: readonly ('APPLICATION' | 'INVITATION')[];
}): SQL {
  return sql`
    manager_requests AS MATERIALIZED (
      SELECT r.*
      FROM "GroupRequestProjection" r
      WHERE r."threadId" = ${params.threadId} AND r."memberAccount" = ${params.memberAccount}
        AND r."memberDomain" = ${params.memberDomain} AND r."memberNamespaceId" = ${params.memberNamespaceId}
        AND r.direction = ANY(${sql.param(params.directions)}::text[])
        AND r.status IS DISTINCT FROM ${params.status}
    ), request_projection AS (
      UPDATE "GroupRequestProjection" r SET status = ${params.status}
      FROM manager_requests p
      WHERE r."threadId" = p."threadId" AND r."memberAccount" = p."memberAccount"
        AND r."memberDomain" = p."memberDomain" AND r."memberNamespaceId" = p."memberNamespaceId" AND r.direction = p.direction
      RETURNING 1
    )`;
}
