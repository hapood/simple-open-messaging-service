import type { DatabaseTransaction } from '../database/database.service.js';
import { sql } from 'drizzle-orm';

export interface BusinessScopeAddress {
  account: string;
  domain: string;
}

export function businessAccountScopeKey(address: BusinessScopeAddress): string {
  return JSON.stringify([
    'business-scope',
    'ACCOUNT',
    address.domain.toLowerCase(),
    address.account,
  ]);
}

/** Locks every participating user or group address in one global order. */
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
