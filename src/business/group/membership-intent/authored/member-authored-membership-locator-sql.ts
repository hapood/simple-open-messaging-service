import { sql } from 'drizzle-orm';
import { groupStateSql } from '../../shared/group-state.js';

/** Names the group business scope and local member before locking. It does not
 * authorize a transition; mutable membership state is read again under locks. */
export function memberAuthoredMembershipLocatorSql(input: {
  threadId: number;
  memberUserId: number;
}) {
  return sql`
    SELECT g.account AS "groupAccount", g.domain AS "groupDomain",
      g."namespaceId" AS "groupNamespaceId",
      g."dissolvedAt" AS "dissolvedAt",
      a.account AS "memberAccount"
    FROM ${groupStateSql} g
    JOIN "Account" a ON a.id = ${input.memberUserId}
      AND a.domain = 'local' AND a."namespaceId" = 0
    WHERE g.id = ${input.threadId}
  `;
}
