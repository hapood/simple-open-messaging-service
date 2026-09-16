import { sql } from 'drizzle-orm';
import { normalizeAccount } from '../../../common/account.js';
import type { DatabaseTransaction } from '../../../database/database.service.js';
import { lockBusinessAccountsInTx } from '../../shared/locks/account-business-lock.js';
import { requireThreadContentLockInTx } from '../../shared/locks/thread-content-lock.js';
import { readGroupState } from '../shared/group-state.js';
import { and, eq } from 'drizzle-orm';
import { groupStateFields } from '../shared/group-state.js';
import type { MirrorGroupAddress } from './mirror-meta-shared.js';

/** The authoritative group's meta head merges its end into the mirror's
 * target — creating the mirror cursor row when absent — inside the
 * head-consumption transaction. A zero processed cursor opens a full snapshot
 * window fixed at the merged target, so a restart resumes the same window
 * instead of re-deriving it. Returns the mirror thread id for the caller's
 * round wake, or null when this peer hosts no mirror for the group.
 *
 * Lock order: group Account State scope, Thread Content lock, GroupMeta. */
export async function mergeMirrorGroupMetaTargetInTx(
  tx: DatabaseTransaction,
  input: { group: MirrorGroupAddress; metaTargetId: number },
): Promise<{ threadId: number } | null> {
  const account = normalizeAccount(input.group.account);
  await lockBusinessAccountsInTx(tx, [
    { account, domain: input.group.domain },
  ]);
  const mirror = await readGroupState(
    tx,
    and(
      eq(groupStateFields.account, account),
      eq(groupStateFields.domain, input.group.domain),
      eq(groupStateFields.namespaceId, input.group.namespaceId),
    ),
  );
  if (!mirror) return null;
  await requireThreadContentLockInTx(tx, mirror.id);
  // A non-positive coordinate carries no window: the row exists so later
  // merges can advance, but there is nothing to snapshot yet.
  const windowThrough = input.metaTargetId > 0 ? input.metaTargetId : null;
  await tx.execute(sql`
    INSERT INTO "GroupMeta" ("threadId", "metaTargetId", "metaRecoveryThroughId")
    VALUES (${mirror.id}, ${input.metaTargetId}, ${windowThrough})
    ON CONFLICT ("threadId") DO UPDATE SET
      "metaTargetId" = GREATEST("GroupMeta"."metaTargetId", EXCLUDED."metaTargetId"),
      "metaRecoveryThroughId" = CASE
        WHEN "GroupMeta"."metaProcessedThroughId" = 0
          THEN GREATEST("GroupMeta"."metaTargetId", EXCLUDED."metaTargetId")
        ELSE "GroupMeta"."metaRecoveryThroughId" END,
      "updatedAt" = CURRENT_TIMESTAMP
  `);
  return { threadId: mirror.id };
}
