import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { GroupRole } from '../database/enums.js';

export interface CurrentGroupRosterMember extends Record<string, unknown> {
  userId: number;
  account: string;
  domain: string;
  namespaceId: number;
  role: GroupRole;
  profileRev: number;
  available: boolean;
}

export interface CurrentLocalGroupManager extends Record<string, unknown> {
  userId: number;
}

export interface CurrentGroupOwner extends Record<string, unknown> {
  groupId: number;
  userId: number;
}

/** Reads one current member without expanding the complete group roster. */
export async function readCurrentGroupMemberInTx(
  tx: DatabaseTransaction,
  groupId: number,
  memberUserId: number,
): Promise<CurrentGroupRosterMember | undefined> {
  if (!Number.isSafeInteger(groupId) || groupId <= 0)
    throw new TypeError('invalid group ID');
  if (!Number.isSafeInteger(memberUserId) || memberUserId <= 0)
    throw new TypeError('invalid member user ID');
  const result = await tx.execute<CurrentGroupRosterMember>(sql`
    SELECT member_identity.id AS "userId", member_identity.account,
           member_identity.domain, member_identity."namespaceId",
           latest.body ->> 'role' AS role,
           (latest.body ->> 'profileRev')::integer AS "profileRev",
           member_identity.availability = 'AVAILABLE' AS available
    FROM (
      SELECT operation, body
      FROM "GroupMetaMemberFeed"
      WHERE "groupId" = ${groupId} AND "memberUserId" = ${memberUserId}
      ORDER BY "feedId" DESC
      LIMIT 1
    ) latest
    JOIN "User" member_identity ON member_identity.id = ${memberUserId}
    WHERE latest.operation = 'UPSERT'
  `);
  const member = result.rows[0];
  if (member) validateCurrentMember(member);
  return member;
}

/** Resolves one current member by its protocol address within a specific group. */
export async function readCurrentGroupMemberByAddressInTx(
  tx: DatabaseTransaction,
  groupId: number,
  identity: { account: string; domain: string },
): Promise<CurrentGroupRosterMember | undefined> {
  if (!Number.isSafeInteger(groupId) || groupId <= 0)
    throw new TypeError('invalid group ID');
  if (identity.account.length === 0 || identity.domain.length === 0)
    throw new TypeError('invalid member address');
  const result = await tx.execute<CurrentGroupRosterMember>(sql`
    SELECT member_identity.id AS "userId", member_identity.account,
           member_identity.domain, member_identity."namespaceId",
           latest.body ->> 'role' AS role,
           (latest.body ->> 'profileRev')::integer AS "profileRev",
           member_identity.availability = 'AVAILABLE' AS available
    FROM (
      SELECT "memberUserId", operation, body
      FROM "GroupMetaMemberFeed" member_fact
      JOIN "User" source_identity
        ON source_identity.id = member_fact."memberUserId"
      WHERE member_fact."groupId" = ${groupId}
        AND source_identity.account = ${identity.account}
        AND source_identity.domain = ${identity.domain}
      ORDER BY member_fact."feedId" DESC
      LIMIT 1
    ) latest
    JOIN "User" member_identity ON member_identity.id = latest."memberUserId"
    WHERE latest.operation = 'UPSERT'
  `);
  const member = result.rows[0];
  if (member) validateCurrentMember(member);
  return member;
}

/** Reads the current roster from the newest canonical or mirrored Group Meta
 * operation for each stable member identity. */
export async function readCurrentGroupRosterInTx(
  tx: DatabaseTransaction,
  groupId: number,
): Promise<CurrentGroupRosterMember[]> {
  if (!Number.isSafeInteger(groupId) || groupId <= 0)
    throw new TypeError('invalid group ID');
  const result = await tx.execute<CurrentGroupRosterMember>(sql`
    SELECT latest."userId", latest.account, latest.domain,
           latest."namespaceId",
           latest.body ->> 'role' AS role,
           (latest.body ->> 'profileRev')::integer AS "profileRev",
           latest.availability = 'AVAILABLE' AS available
    FROM (
      SELECT DISTINCT ON (member_identity.domain, member_identity.account)
        member_fact."memberUserId" AS "userId",
        member_identity.account,
        member_identity.domain,
        member_identity."namespaceId",
        member_identity.availability,
        member_fact.operation,
        member_fact.body
      FROM "GroupMetaMemberFeed" member_fact
      JOIN "User" member_identity
        ON member_identity.id = member_fact."memberUserId"
      WHERE member_fact."groupId" = ${groupId}
      ORDER BY member_identity.domain, member_identity.account,
               member_fact."feedId" DESC
    ) latest
    WHERE latest.operation = 'UPSERT'
  `);
  for (const member of result.rows) validateCurrentMember(member);
  return result.rows;
}

/** Batch-reads each group's current owner from its latest member operations. */
export async function readCurrentGroupOwnersInTx(
  tx: DatabaseTransaction,
  groupIds: readonly number[],
): Promise<CurrentGroupOwner[]> {
  const uniqueGroupIds = [...new Set(groupIds)];
  for (const groupId of uniqueGroupIds) {
    if (!Number.isSafeInteger(groupId) || groupId <= 0)
      throw new TypeError('invalid group ID');
  }
  if (uniqueGroupIds.length === 0) return [];

  const result = await tx.execute<CurrentGroupOwner>(sql`
    SELECT latest."groupId", latest."userId"
    FROM (
      SELECT DISTINCT ON (
        member_fact."groupId", member_identity.domain, member_identity.account
      )
        member_fact."groupId",
        member_fact."memberUserId" AS "userId",
        member_fact.operation,
        member_fact.body
      FROM "GroupMetaMemberFeed" member_fact
      JOIN "User" member_identity
        ON member_identity.id = member_fact."memberUserId"
      WHERE member_fact."groupId" IN (${sql.join(
        uniqueGroupIds.map((groupId) => sql`${groupId}`),
        sql`, `,
      )})
      ORDER BY member_fact."groupId", member_identity.domain,
               member_identity.account, member_fact."feedId" DESC
    ) latest
    WHERE latest.operation = 'UPSERT'
      AND latest.body ->> 'role' = 'OWNER'
  `);

  const seen = new Set<number>();
  for (const owner of result.rows) {
    if (
      !Number.isSafeInteger(owner.groupId) ||
      owner.groupId <= 0 ||
      !Number.isSafeInteger(owner.userId) ||
      owner.userId <= 0 ||
      seen.has(owner.groupId)
    )
      throw new Error('invalid current Group Meta owner set');
    seen.add(owner.groupId);
  }
  return result.rows;
}

/** Reads only current local OWNER/ADMIN identities and their existing client projections. */
export async function readCurrentLocalGroupManagersInTx(
  tx: DatabaseTransaction,
  params: { groupId: number; threadId: number; managerUserId?: number },
): Promise<CurrentLocalGroupManager[]> {
  if (!Number.isSafeInteger(params.groupId) || params.groupId <= 0)
    throw new TypeError('invalid group ID');
  if (!Number.isSafeInteger(params.threadId) || params.threadId <= 0)
    throw new TypeError('invalid thread ID');
  if (
    params.managerUserId !== undefined &&
    (!Number.isSafeInteger(params.managerUserId) || params.managerUserId <= 0)
  )
    throw new TypeError('invalid manager user ID');
  const result = await tx.execute<CurrentLocalGroupManager>(sql`
    SELECT latest."userId"
    FROM (
      SELECT DISTINCT ON (member_identity.domain, member_identity.account)
        member_fact."memberUserId" AS "userId",
        member_identity.account,
        member_identity.domain,
        member_identity."namespaceId",
        member_fact.operation,
        member_fact.body
      FROM "GroupMetaMemberFeed" member_fact
      JOIN "User" member_identity
        ON member_identity.id = member_fact."memberUserId"
      WHERE member_fact."groupId" = ${params.groupId}
        AND member_identity.domain = 'local'
        AND member_identity."namespaceId" = 0
        ${params.managerUserId === undefined ? sql.empty() : sql`AND member_identity.id = ${params.managerUserId}`}
      ORDER BY member_identity.domain, member_identity.account,
               member_fact."feedId" DESC
    ) latest
    JOIN "AccountThreadState" participant
      ON participant."accountId" = latest."userId"
     AND participant."threadId" = ${params.threadId}
    WHERE latest.operation = 'UPSERT'
      AND latest.body ->> 'role' IN ('OWNER', 'ADMIN')
  `);
  return result.rows;
}

/** Reads current local members whose GROUP_MEMBER pair is still active. */
export async function readCurrentLocalAuthorizedGroupMemberIdsInTx(
  tx: DatabaseTransaction,
  params: { groupId: number; threadId: number },
): Promise<number[]> {
  if (!Number.isSafeInteger(params.groupId) || params.groupId <= 0)
    throw new TypeError('invalid group ID');
  if (!Number.isSafeInteger(params.threadId) || params.threadId <= 0)
    throw new TypeError('invalid thread ID');
  const result = await tx.execute<{ userId: number }>(sql`
    SELECT latest."userId"
    FROM (
      SELECT DISTINCT ON (member_identity.domain, member_identity.account)
        member_fact."memberUserId" AS "userId",
        member_identity.account,
        member_identity.domain,
        member_identity."namespaceId",
        member_identity.availability,
        member_fact.operation
      FROM "GroupMetaMemberFeed" member_fact
      JOIN "User" member_identity
        ON member_identity.id = member_fact."memberUserId"
      WHERE member_fact."groupId" = ${params.groupId}
        AND member_identity.domain = 'local'
        AND member_identity."namespaceId" = 0
      ORDER BY member_identity.domain, member_identity.account,
               member_fact."feedId" DESC
    ) latest
    JOIN "AccountThreadState" participant
      ON participant."accountId" = latest."userId"
     AND participant."threadId" = ${params.threadId}
    WHERE latest.operation = 'UPSERT'
      AND latest.availability = 'AVAILABLE'
      AND EXISTS (
        SELECT 1
        FROM "RelationshipPair" pair
        WHERE pair.kind = 'GROUP_MEMBER'
          AND pair."threadId" = ${params.threadId}
          AND pair.active = true
          AND pair."endpointBType" = 'USER'
          AND pair."endpointBAccount" = latest.account
          AND pair."endpointBDomain" = latest.domain
      )
  `);
  return result.rows.map((row) => row.userId);
}

function validateCurrentMember(member: CurrentGroupRosterMember): void {
  if (
    !Object.values(GroupRole).includes(member.role) ||
    !Number.isSafeInteger(member.profileRev) ||
    member.profileRev < 0
  )
    throw new Error('invalid current Group Meta member');
}
