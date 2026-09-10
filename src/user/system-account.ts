import { eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { account } from '../database/schema.js';

/** Provisioned by the migration; its reserved address is outside user account grammar. */
export async function systemAccountIdInTx(
  tx: DatabaseTransaction,
): Promise<number> {
  let system = await tx.query.account.findFirst({
    where: eq(account.kind, 'SYSTEM'),
    columns: { id: true },
  });
  if (!system) {
    // Restore the singleton after a database reset; it never joins business relationships.
    await tx
      .insert(account)
      .values({ account: '$system', kind: 'SYSTEM', disabledAt: new Date() })
      .onConflictDoNothing({ target: account.account });
    system = await tx.query.account.findFirst({
      where: eq(account.kind, 'SYSTEM'),
      columns: { id: true },
    });
  }
  if (!system) throw new Error('System account is missing');
  return system.id;
}
