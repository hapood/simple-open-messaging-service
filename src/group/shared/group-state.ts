import { and, eq, sql, type SQL } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import {
  groupAccount,
  groupMeta,
  messageThread,
  profileTable,
} from '../../database/schema.js';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { requireThreadContentLockInTx } from '../../common/locks/thread-content-lock.js';

/** Read-only group presentation. Group coordinates are thread IDs, including mirrored groups. */
const revision = sql<number>`COALESCE(${groupAccount.defaultProfileRev}, ${groupMeta.profileRev}, 0)`;
const query = new QueryBuilder()
  .select({
    id: messageThread.id,
    account: sql<string>`${messageThread.groupAccount}`.as('account'),
    domain: sql<string>`${messageThread.groupDomain}`.as('domain'),
    namespaceId: sql<number>`${messageThread.authorityNamespaceId}`.as(
      'namespaceId',
    ),
    name: sql<string>`COALESCE(${profileTable.displayName}, ${messageThread.groupAccount})`.as(
      'name',
    ),
    avatar: sql<string>`COALESCE(${profileTable.avatar}, '')`.as('avatar'),
    description: sql<string>`COALESCE(${profileTable.bio}, '')`.as(
      'description',
    ),
    profileRev: revision.as('profileRev'),
    createdAt: messageThread.createdAt,
    updatedAt: messageThread.updatedAt,
    dissolvedAt:
      sql<Date | null>`COALESCE(${groupAccount.dissolvedAt}, ${messageThread.groupDissolvedAt})`
        .mapWith(messageThread.groupDissolvedAt)
        .as('dissolvedAt'),
  })
  .from(messageThread)
  .leftJoin(groupAccount, eq(groupAccount.id, messageThread.groupAccountId))
  .leftJoin(groupMeta, eq(groupMeta.threadId, messageThread.id))
  .leftJoin(
    profileTable,
    and(
      eq(profileTable.account, messageThread.groupAccount),
      eq(profileTable.domain, messageThread.groupDomain),
      eq(profileTable.publisherNamespaceId, 0),
      eq(profileTable.profileNamespaceId, messageThread.authorityNamespaceId),
      eq(profileTable.profileRev, revision),
    ),
  )
  .where(eq(messageThread.type, 'GROUP'));

export const groupState = query.as('group_state');
export const groupStateSql = sql`(${query.getSQL()})`;
export const groupStateFields = {
  id: groupState.id,
  account: sql<string>`"group_state"."account"`,
  domain: sql<string>`"group_state"."domain"`,
  namespaceId: sql<number>`"group_state"."namespaceId"`,
  name: sql<string>`"group_state"."name"`,
  avatar: sql<string>`"group_state"."avatar"`,
  description: sql<string>`"group_state"."description"`,
  profileRev: sql<number>`"group_state"."profileRev"`,
  createdAt: groupState.createdAt,
  updatedAt: groupState.updatedAt,
  dissolvedAt: sql<Date | null>`"group_state"."dissolvedAt"`.mapWith(
    messageThread.groupDissolvedAt,
  ),
};

export async function readGroupState(
  db: Pick<DatabaseTransaction, 'select'>,
  where: SQL | undefined,
) {
  const [row] = await db
    .select(groupStateFields)
    .from(groupState)
    .where(where)
    .limit(1);
  return row;
}

/** Serialize the terminal-state check with group mutations before any intent or projection writes. */
export async function isGroupDissolvedInTx(
  tx: DatabaseTransaction,
  threadId: number,
): Promise<boolean> {
  await requireThreadContentLockInTx(tx, threadId);
  const state = await readGroupState(tx, eq(groupStateFields.id, threadId));
  if (!state) throw new Error('group interaction target is missing');
  return state.dissolvedAt !== null;
}
