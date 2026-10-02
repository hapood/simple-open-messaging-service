import type { DatabaseTransaction } from '../../database/database.service.js';
import { sql } from 'drizzle-orm';

export interface BusinessScopeAddress {
  account: string;
  profileNamespaceId: number;
}

/** Canonical key for mutable state owned by one acting account. Referencing an
 * account from a relationship does not make that account part of this scope. */
export function businessAccountScopeKey(address: BusinessScopeAddress): string {
  return JSON.stringify([
    'business-scope',
    'ACCOUNT',
    address.profileNamespaceId,
    address.account,
  ]);
}

/** Acquires every owned account-state scope in one global order. */
export async function lockBusinessAccountsInTx(
  tx: DatabaseTransaction,
  addresses: readonly BusinessScopeAddress[],
): Promise<void> {
  const keys = [
    ...new Set(addresses.map((address) => businessAccountScopeKey(address))),
  ].sort();
  for (const key of keys)
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
    `);
}
