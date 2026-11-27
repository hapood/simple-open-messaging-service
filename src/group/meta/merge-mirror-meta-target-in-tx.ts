import { sql } from 'drizzle-orm';
import { normalizeAccount } from '../../common/account.js';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { lockBusinessAccountsInTx } from '../../common/locks/account-business-lock.js';
import { requireThreadContentLockInTx } from '../../common/locks/thread-content-lock.js';
import { readGroupState } from '../shared/group-state.js';
import { and, eq } from 'drizzle-orm';
import { groupStateFields } from '../shared/group-state.js';
import {
  beginMirrorMetaRecoveryInTx,
  type MirrorGroupAddress,
} from './mirror-meta-shared.js';

/** The authoritative group's meta head merges its end into the mirror's
 * target — creating the mirror cursor row when absent — inside the
 * head-consumption transaction. The first row opens a full window through
 * `beginMirrorMetaRecoveryInTx`. A later head only raises `metaTargetId`;
 * an open window's `metaRecoveryThroughId` stays fixed. Returns the mirror
 * thread id for the caller's round wake, or null when this peer hosts no
 * mirror for the group.
 *
 * Lock order: group Account State scope, Thread Content lock, GroupMeta. */
export async function mergeMirrorGroupMetaTargetInTx(
  tx: DatabaseTransaction,
  input: { group: MirrorGroupAddress; metaTargetId: number },
): Promise<{ threadId: number } | null> {
  const account = normalizeAccount(input.group.account);
  await lockBusinessAccountsInTx(tx, [
    { account, profileNamespaceId: input.group.publisherNamespaceId },
  ]);
  const mirror = await readGroupState(
    tx,
    and(
      eq(groupStateFields.account, account),
      eq(groupStateFields.namespaceId, input.group.publisherNamespaceId),
    ),
  );
  if (!mirror) return null;
  await requireThreadContentLockInTx(tx, mirror.id);
  const merged = await tx.execute<{
    metaProcessedThroughId: number;
    metaRecoveryThroughId: number;
  }>(sql`
    INSERT INTO "GroupMeta" ("threadId", "metaTargetId")
    VALUES (${mirror.id}, ${input.metaTargetId})
    ON CONFLICT ("threadId") DO UPDATE SET
      "metaTargetId" = GREATEST("GroupMeta"."metaTargetId", EXCLUDED."metaTargetId"),
      "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "metaProcessedThroughId", "metaRecoveryThroughId"
  `);
  const row = merged.rows[0];
  if (
    input.metaTargetId > 0 &&
    row?.metaProcessedThroughId === 0 &&
    row?.metaRecoveryThroughId === 0
  ) {
    await beginMirrorMetaRecoveryInTx(tx, input.group, input.metaTargetId);
  }
  return { threadId: mirror.id };
}
