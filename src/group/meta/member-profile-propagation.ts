import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { lockBusinessAccountsInTx } from '../../common/locks/account-business-lock.js';
import { requireThreadContentLockInTx } from '../../common/locks/thread-content-lock.js';
import { enqueueCurrentThreadFanoutsInTx } from '../../message/thread-fanout-task.js';
import { GroupMetaFeedService } from './group-meta-feed.service.js';
import { readCurrentGroupMemberByAddressInTx } from './current-group-roster.js';

/** Publish local roster evidence and durable fanout atomically with the profile. */
export async function propagateLocalMemberProfileInTx(
  tx: DatabaseTransaction,
  meta: GroupMetaFeedService,
  account: string,
  profileRev: number,
): Promise<void> {
  const groups = await tx.execute<{ threadId: number; account: string }>(sql`
    SELECT t.id AS "threadId", t."groupAccount" AS account
    FROM "MessageThread" t
    JOIN "GroupMetaMemberFeed" f ON f."threadId" = t.id
    WHERE f."memberAccount" = ${account} AND f."memberDomain" = 'local'
      AND f.operation = 'MEMBER_UPSERT' AND t.type = 'GROUP'
      AND t."groupDomain" = 'local' AND t."groupAccountId" IS NOT NULL
    ORDER BY t.id
  `);
  // Acquire all parent scopes in canonical order before any child/feed locks.
  await lockBusinessAccountsInTx(
    tx,
    groups.rows.map((group) => ({ account: group.account, domain: 'local' })),
  );
  for (const group of groups.rows) {
    const lock = await requireThreadContentLockInTx(tx, group.threadId);
    // Membership may have changed while waiting for the group scope.
    const member = await readCurrentGroupMemberByAddressInTx(
      tx,
      group.threadId,
      {
        account,
        domain: 'local',
        namespaceId: 0,
      },
    );
    if (!member || member.profileRev >= profileRev) continue;
    await meta.reconcileMembersInTx(tx, group.threadId, [
      {
        account,
        domain: 'local',
        operation: 'MEMBER_UPSERT',
        body: { role: member.role, profileRev },
      },
    ]);
    await enqueueCurrentThreadFanoutsInTx(tx, lock);
  }
}
