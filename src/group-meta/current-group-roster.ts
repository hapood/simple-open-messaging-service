import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { GroupRole } from '../database/enums.js';
import {
  accountAddressInTx,
  type AccountTarget,
} from '../user/account-address.js';
import type { NamespacedAddress } from '../common/client-identity.js';

export interface CurrentGroupRosterMember
  extends Record<string, unknown>,
    NamespacedAddress {
  role: GroupRole;
  profileRev: number;
}
export interface CurrentLocalGroupManager extends Record<string, unknown> {
  userId: number;
}
export interface CurrentGroupOwner extends Record<string, unknown> {
  groupId: number;
  identity: NamespacedAddress;
}

type RosterRow = Record<string, unknown> &
  NamespacedAddress & { role: GroupRole; profileRev: number };
function member(row: RosterRow): CurrentGroupRosterMember {
  if (
    !Object.values(GroupRole).includes(row.role) ||
    !Number.isSafeInteger(row.profileRev) ||
    row.profileRev < 0
  )
    throw new Error('invalid current Group Meta member');
  return row;
}
function validateGroupId(groupId: number) {
  if (!Number.isSafeInteger(groupId) || groupId <= 0)
    throw new TypeError('invalid group ID');
}

export async function readCurrentGroupMemberInTx(
  tx: DatabaseTransaction,
  groupId: number,
  target: AccountTarget,
) {
  return readCurrentGroupMemberByAddressInTx(
    tx,
    groupId,
    await accountAddressInTx(tx, target),
  );
}

export async function readCurrentGroupMemberByAddressInTx(
  tx: DatabaseTransaction,
  groupId: number,
  identity: { account: string; domain: string; namespaceId?: number },
): Promise<CurrentGroupRosterMember | undefined> {
  validateGroupId(groupId);
  const result = await tx.execute<RosterRow>(sql`
    SELECT latest."memberAccount" AS account, latest."memberDomain" AS domain,
      latest."memberNamespaceId" AS "namespaceId", latest.body ->> 'role' AS role,
      (latest.body ->> 'profileRev')::integer AS "profileRev"
    FROM (
      SELECT * FROM "GroupMetaMemberFeed" WHERE "threadId" = ${groupId}
        AND "memberAccount" = ${identity.account} AND "memberDomain" = ${identity.domain}
        ${identity.namespaceId === undefined ? sql.empty() : sql`AND "memberNamespaceId" = ${identity.namespaceId}`}
      ORDER BY "feedId" DESC LIMIT 1
    ) latest WHERE latest.operation = 'UPSERT'
  `);
  return result.rows[0] ? member(result.rows[0]) : undefined;
}

export async function readCurrentGroupRosterInTx(
  tx: DatabaseTransaction,
  groupId: number,
): Promise<CurrentGroupRosterMember[]> {
  validateGroupId(groupId);
  const result = await tx.execute<RosterRow>(sql`
    SELECT latest."memberAccount" AS account, latest."memberDomain" AS domain,
      latest."memberNamespaceId" AS "namespaceId", latest.body ->> 'role' AS role,
      (latest.body ->> 'profileRev')::integer AS "profileRev"
    FROM (
      SELECT DISTINCT ON ("memberAccount", "memberDomain") * FROM "GroupMetaMemberFeed"
      WHERE "threadId" = ${groupId} ORDER BY "memberAccount", "memberDomain", "feedId" DESC
    ) latest WHERE latest.operation = 'UPSERT'
  `);
  return result.rows.map(member);
}

export async function readCurrentGroupOwnersInTx(
  tx: DatabaseTransaction,
  groupIds: readonly number[],
): Promise<CurrentGroupOwner[]> {
  const ids = [...new Set(groupIds)];
  ids.forEach(validateGroupId);
  if (!ids.length) return [];
  const result = await tx.execute<
    Record<string, unknown> & NamespacedAddress & { groupId: number }
  >(sql`
    SELECT latest."threadId" AS "groupId", latest."memberAccount" AS account, latest."memberDomain" AS domain,
      latest."memberNamespaceId" AS "namespaceId"
    FROM (
      SELECT DISTINCT ON ("threadId", "memberAccount", "memberDomain") * FROM "GroupMetaMemberFeed"
      WHERE "threadId" = ANY(${sql.param(ids)}::integer[])
      ORDER BY "threadId", "memberAccount", "memberDomain", "feedId" DESC
    ) latest WHERE latest.operation = 'UPSERT' AND latest.body ->> 'role' = 'OWNER'
  `);
  const seen = new Set<number>();
  return result.rows.map(({ groupId, ...identity }) => {
    if (seen.has(groupId))
      throw new Error('invalid current Group Meta owner set');
    seen.add(groupId);
    return { groupId, identity };
  });
}

/** Local delivery resolution is separate from projecting roster identities. */
export async function readCurrentLocalGroupManagersInTx(
  tx: DatabaseTransaction,
  params: { groupId: number; threadId: number; managerUserId?: number },
): Promise<CurrentLocalGroupManager[]> {
  validateGroupId(params.groupId);
  if (
    params.managerUserId !== undefined &&
    (!Number.isSafeInteger(params.managerUserId) || params.managerUserId <= 0)
  )
    throw new TypeError('invalid manager user ID');
  const result = await tx.execute<{ userId: number }>(sql`
    SELECT owner.id AS "userId" FROM (
      SELECT DISTINCT ON ("memberAccount", "memberDomain") * FROM "GroupMetaMemberFeed"
      WHERE "threadId" = ${params.groupId}
      ORDER BY "memberAccount", "memberDomain", "feedId" DESC
    ) latest
    JOIN "Account" owner ON latest."memberDomain" = 'local' AND latest."memberNamespaceId" = 0
      AND owner.account = latest."memberAccount"
    JOIN "AccountThreadState" participant ON participant."accountId" = owner.id AND participant."threadId" = ${params.threadId}
    WHERE latest.operation = 'UPSERT' AND latest.body ->> 'role' IN ('OWNER', 'ADMIN')
      ${params.managerUserId === undefined ? sql.empty() : sql`AND owner.id = ${params.managerUserId}`}
    ORDER BY owner.id
  `);
  return result.rows;
}

export async function readCurrentLocalAuthorizedGroupMemberIdsInTx(
  tx: DatabaseTransaction,
  params: { groupId: number; threadId: number },
): Promise<number[]> {
  validateGroupId(params.groupId);
  const result = await tx.execute<{ userId: number }>(sql`
    SELECT identity.id AS "userId" FROM "AccountThreadState" participant
    JOIN "MessageThread" thread ON thread.id = participant."threadId"
    JOIN "Account" identity ON identity.id = participant."accountId"
    WHERE thread.id = ${params.threadId} AND thread.id = ${params.groupId}
      AND identity.availability = 'AVAILABLE'
      AND EXISTS (
        SELECT 1 FROM "RelationshipPair" pair WHERE pair.kind = 'GROUP_MEMBER'
          AND pair."threadId" = thread.id AND pair.active = true
          AND pair."endpointBType" = 'USER' AND pair."endpointBDomain" = 'local'
          AND pair."endpointBAccount" = identity.account
      ) ORDER BY identity.id
  `);
  return result.rows.map((row) => row.userId);
}
