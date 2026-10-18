import { sql } from 'drizzle-orm';
import { groupStateSql } from '../../shared/group-state.js';

/** Pre-lock locator for a member-authored group membership intent. It names
 * the advisory scopes and reads only stable coordinates; authorization and
 * mutable state are re-read after the locks. */
export function memberAuthoredMembershipLocatorSql(input: {
  threadId: number;
  memberUserId: number;
}) {
  return sql`
    SELECT g.account AS "groupAccount",
      g."namespaceId" AS "groupNamespaceId",
      g."dissolvedAt" AS "dissolvedAt",
      a.account AS "memberAccount"
    FROM ${groupStateSql} g
    JOIN "Account" a ON a.id = ${input.memberUserId}
      AND a."namespaceId" = 0
    WHERE g.id = ${input.threadId}
  `;
}
