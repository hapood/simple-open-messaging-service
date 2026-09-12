import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../database/database.service.js';

/** Complete endpoint address, e.g. `alice@local` or `bob@peer.example.com`. */
export type PairEndpointAddress = string;

/** Both endpoints of one relationship. Addresses must arrive complete, lowercase,
 * and free of whitespace, in any order. Nothing here normalizes or checks them. */
export interface PairAddressScope {
  readonly kind: string;
  readonly addresses: readonly [PairEndpointAddress, PairEndpointAddress];
}

/** Direction-independent: endpoint order does not change the key. */
export function experimentalPairBusinessKey(pair: PairAddressScope): string {
  const [first, second] = [...pair.addresses].sort();
  return JSON.stringify(['business-scope', 'PAIR', pair.kind, first, second]);
}

/** Experimental transaction owners acquire all group scopes before any pair scope,
 * then row/allocator locks. Existing production writers retain their original locks. */
export async function lockExperimentalPairsInTx(
  tx: DatabaseTransaction,
  pairs: readonly PairAddressScope[],
): Promise<void> {
  const keys = [...new Set(pairs.map(experimentalPairBusinessKey))].sort();
  for (const key of keys)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
}
