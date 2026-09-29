import { sql } from 'drizzle-orm';
import { groupStateSql } from '../shared/group-state.js';
import { GroupRole } from '../../database/enums.js';

/** Post-lock authorization row for one roster-role command. Identity columns
 * are echoed from the command's target so a never-rostered address is still
 * describable; every mutable field is read fresh under the locks. */
export type GroupRosterRoleAuthorizationRow = {
  groupAccount: string;
  groupDomain: string;
  namespaceId: number;
  dissolvedAt: string | null;
  /** Local account address of the acting user (the command's operator). */
  operatorAccount: string | null;
  /** The operator's canonical roster role, or null when not rostered. */
  operatorRole: GroupRole | null;
  operatorProfileRev: number | null;
  /** Rostered owner/admin with an active member pair and a thread participant row. */
  operatorAuthorized: boolean;
  targetAccount: string | null;
  targetDomain: string | null;
  targetNamespaceId: number | null;
  /** The target's canonical roster role, or null when not rostered. */
  targetRole: GroupRole | null;
  targetProfileRev: number | null;
  /** Rostered member whose member pair is still active. */
  targetActive: boolean;
  /** Local Account.id of the target, or null for a peer-hosted one. */
  localTargetId: number | null;
};

/** Use before locking only to name the group's business scope. It authorizes
 * nothing: every mutable state is re-read under the locks by the
 * authorization statement. */
export function groupRosterRoleLocatorSql(input: { threadId: number }) {
  return sql`
    SELECT g.account AS "groupAccount", g.domain AS "groupDomain"
    FROM ${groupStateSql} g WHERE g.id = ${input.threadId}
  `;
}

/** One fresh post-lock statement validates the authoritative group, the
 * acting owner, and the target's roster state. Roles and profile revisions
 * come from the canonical Group Meta roster; liveness comes from each side's
 * GROUP_MEMBER pair, exactly like the membership-intent family's checks. */
export function groupRosterRoleAuthorizationSql(input: {
  threadId: number;
  operatorUserId: number;
  targetAccount: string;
  targetDomain: string;
}) {
  return sql`
    WITH operator_account AS MATERIALIZED (
      SELECT id, account FROM "Account"
      WHERE id = ${input.operatorUserId} AND domain = 'local' AND "namespaceId" = 0
    ), operator_roster AS MATERIALIZED (
      SELECT latest.body ->> 'role' AS role,
        (latest.body ->> 'profileRev')::integer AS "profileRev"
      FROM (
        SELECT * FROM "GroupMetaMemberFeed"
        WHERE "threadId" = ${input.threadId}
          AND "memberAccount" = (SELECT account FROM operator_account)
          AND "memberDomain" = 'local'
        ORDER BY "feedId" DESC LIMIT 1
      ) latest WHERE latest.operation = 'MEMBER_UPSERT'
    ), target_roster AS MATERIALIZED (
      SELECT latest."memberAccount" AS account, latest."memberDomain" AS domain,
        group_meta_member_namespace(latest."threadId", latest."memberAccount",
          latest."memberDomain") AS "namespaceId",
        latest.body ->> 'role' AS role,
        (latest.body ->> 'profileRev')::integer AS "profileRev"
      FROM (
        SELECT * FROM "GroupMetaMemberFeed"
        WHERE "threadId" = ${input.threadId}
          AND "memberAccount" = ${input.targetAccount}
          AND "memberDomain" = ${input.targetDomain}
        ORDER BY "feedId" DESC LIMIT 1
      ) latest WHERE latest.operation = 'MEMBER_UPSERT'
    )
    SELECT g.account AS "groupAccount", g.domain AS "groupDomain",
      g."namespaceId", g."dissolvedAt",
      operator.account AS "operatorAccount",
      operator_roster.role AS "operatorRole",
      operator_roster."profileRev" AS "operatorProfileRev",
      EXISTS (
        SELECT 1 FROM "RelationshipPair" pair
        WHERE pair.kind = 'GROUP_MEMBER' AND pair."threadId" = ${input.threadId}
          AND pair.active AND pair."endpointBType" = 'USER'
          AND pair."endpointBNamespaceId" = 0
          AND pair."endpointBAccount" = operator.account
      ) AND EXISTS (
        SELECT 1 FROM "AccountThreadState" participant
        WHERE participant."threadId" = ${input.threadId}
          AND participant."accountId" = operator.id
      ) AS "operatorAuthorized",
      target_roster.account AS "targetAccount",
      target_roster.domain AS "targetDomain",
      target_roster."namespaceId" AS "targetNamespaceId",
      target_roster.role AS "targetRole",
      target_roster."profileRev" AS "targetProfileRev",
      EXISTS (
        SELECT 1 FROM "RelationshipPair" pair
        WHERE pair.kind = 'GROUP_MEMBER' AND pair."threadId" = ${input.threadId}
          AND pair.active AND pair."endpointBType" = 'USER'
          AND pair."endpointBAccount" = ${input.targetAccount}
          AND pair."endpointBNamespaceId" = target_roster."namespaceId"
      ) AS "targetActive",
      local_target.id AS "localTargetId"
    FROM ${groupStateSql} g
    LEFT JOIN operator_account operator ON true
    LEFT JOIN operator_roster ON true
    LEFT JOIN target_roster ON true
    LEFT JOIN "Account" local_target ON target_roster.domain = 'local'
      AND local_target.account = target_roster.account
      AND local_target.domain = 'local' AND local_target."namespaceId" = 0
    WHERE g.id = ${input.threadId}
  `;
}
