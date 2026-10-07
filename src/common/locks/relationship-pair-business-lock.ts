import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import type { RelationshipPairKind } from '../relationship-intent-state.js';
import type { PairEndpointAddress } from './business-address.js';

/** Both endpoints of one relationship. Addresses must arrive complete,
 * normalized, and in any order. Nothing here normalizes or checks them. */
export interface PairAddressScope {
  readonly kind: RelationshipPairKind;
  readonly addresses: readonly [PairEndpointAddress, PairEndpointAddress];
}

function compareEndpoints(
  left: PairEndpointAddress,
  right: PairEndpointAddress,
): number {
  return (
    left.profileNamespaceId - right.profileNamespaceId ||
    left.account.localeCompare(right.account)
  );
}

/** Direction-independent: endpoint order does not change the key. */
export function relationshipPairBusinessKey(pair: PairAddressScope): string {
  const [first, second] = [...pair.addresses].sort(compareEndpoints);
  return JSON.stringify([
    'business-scope',
    'PAIR',
    pair.kind,
    [first.profileNamespaceId, first.account],
    [second.profileNamespaceId, second.account],
  ]);
}

/** Transaction owners acquire all account scopes before any pair scope, then
 * row and allocator locks. */
export async function lockRelationshipPairsInTx(
  tx: DatabaseTransaction,
  pairs: readonly PairAddressScope[],
): Promise<void> {
  const keys = [...new Set(pairs.map(relationshipPairBusinessKey))].sort();
  for (const key of keys)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
}
