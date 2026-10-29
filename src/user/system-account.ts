import { eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { account } from '../database/schema.js';

let cachedSystemAccountId: number | null = null;

/** The reserved system identity: a passwordless, permanently disabled singleton
 * outside user account grammar. Every durable task names an actor, and
 * system-derived work runs on this account's authority; the id is memoized per
 * process to keep fanout admission free of repeated lookups. The unique key on
 * the account name serves every lookup, so no extra index is needed. */
export async function systemAccountIdInTx(
  tx: DatabaseTransaction,
): Promise<number> {
  if (cachedSystemAccountId !== null) return cachedSystemAccountId;
  let system = await tx.query.account.findFirst({
    where: eq(account.account, '$system'),
    columns: { id: true },
  });
  if (!system) {
    await tx
      .insert(account)
      .values({
        account: '$system',
        namespaceId: 0,
        disabledAt: new Date(),
      })
      .onConflictDoNothing({ target: account.account });
    system = await tx.query.account.findFirst({
      where: eq(account.account, '$system'),
      columns: { id: true },
    });
    if (!system) throw new Error('System account is missing');
    // The id exists only if the caller's transaction commits; do not cache it.
    return system.id;
  }
  cachedSystemAccountId = system.id;
  return system.id;
}
