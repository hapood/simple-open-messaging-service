import type { DatabaseTransaction } from '../database/database.service.js';
import { sql } from 'drizzle-orm';

export interface BusinessScopeAddress {
  account: string;
  domain: string;
}

export function userPairBusinessScopeKey(
  endpoints: readonly [BusinessScopeAddress, BusinessScopeAddress],
): string {
  const ordered = endpoints
    .map((endpoint) => [endpoint.domain.toLowerCase(), endpoint.account])
    .sort((left, right) =>
      left[0] === right[0]
        ? left[1]!.localeCompare(right[1]!)
        : left[0]!.localeCompare(right[0]!),
    );
  return JSON.stringify(['business-scope', 'USER_PAIR', ...ordered]);
}

export function groupBusinessScopeKey(address: BusinessScopeAddress): string {
  return JSON.stringify([
    'business-scope',
    'GROUP',
    address.domain.toLowerCase(),
    address.account,
  ]);
}

export async function lockBusinessScopeInTx(
  tx: DatabaseTransaction,
  key: string,
): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
  `);
}
