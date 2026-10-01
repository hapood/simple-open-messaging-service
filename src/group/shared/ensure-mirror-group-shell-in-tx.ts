import { and, eq } from 'drizzle-orm';
import * as tables from '../../database/schema.js';
import { MessageThreadType } from '../../database/enums.js';
import { normalizeAccount } from '../../common/account.js';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { groupStateFields, readGroupState } from './group-state.js';
import { lockBusinessAccountsInTx } from '../../common/locks/account-business-lock.js';

/** Mirror-side group anchor: the GROUP MessageThread row carrying the peer
 * group's coordinates (account/domain/authority namespace). Group coordinates
 * are thread IDs on a mirror, so intent and feed rows need this anchor to
 * exist. The group ACCOUNT scope is taken at the authority domain and is
 * re-entrant, so callers that already hold it lose nothing. */
export async function ensureMirrorGroupShellInTx(
  tx: DatabaseTransaction,
  group: { account: string; domain: string; namespaceId: number },
): Promise<{ threadId: number }> {
  const account = normalizeAccount(group.account);
  const domain = group.domain.trim().toLowerCase();
  await lockBusinessAccountsInTx(tx, [{ account, domain }]);
  const existing = await readGroupState(
    tx,
    and(
      eq(groupStateFields.account, account),
      eq(groupStateFields.domain, domain),
      eq(groupStateFields.namespaceId, group.namespaceId),
    ),
  );
  if (existing) return { threadId: existing.id };
  const [thread] = await tx
    .insert(tables.messageThread)
    .values({
      type: MessageThreadType.GROUP,
      groupAccount: account,
      groupDomain: domain,
      authorityNamespaceId: group.namespaceId,
      updatedAt: new Date(),
    })
    .returning({ id: tables.messageThread.id });
  return { threadId: thread!.id };
}
