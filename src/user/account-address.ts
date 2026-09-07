import { eq, inArray } from 'drizzle-orm';
import type { NamespacedAddress } from '../common/client-identity.js';
import type {
  Database,
  DatabaseTransaction,
} from '../database/database.service.js';
import { account } from '../database/schema.js';

/** Internal commands may identify their local actor by Account.id; foreign subjects use addresses. */
export type AccountTarget = number | NamespacedAddress;

/** Validate a persisted command target without looking up or creating an identity. */
export function readAccountTarget(value: unknown): AccountTarget {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    return value;
  if (!value || typeof value !== 'object')
    throw new Error('invalid account target');
  const identity = value as Record<string, unknown>;
  if (
    typeof identity.account !== 'string' ||
    !identity.account ||
    typeof identity.domain !== 'string' ||
    !identity.domain ||
    typeof identity.namespaceId !== 'number' ||
    !Number.isSafeInteger(identity.namespaceId) ||
    identity.namespaceId < 0 ||
    (identity.domain === 'local') !== (identity.namespaceId === 0)
  )
    throw new Error('invalid addressed account target');
  return {
    account: identity.account,
    domain: identity.domain,
    namespaceId: identity.namespaceId,
  };
}

export async function accountAddressInTx(
  tx: Database | DatabaseTransaction,
  target: AccountTarget,
): Promise<NamespacedAddress> {
  if (typeof target !== 'number') return target;
  const local = await tx.query.account.findFirst({
    where: eq(account.id, target),
    columns: { account: true },
  });
  if (!local) throw new Error('local account does not exist');
  return { account: local.account, domain: 'local', namespaceId: 0 };
}

/** Resolve actual local recipients after subject normalization; foreign addresses are never accounts. */
export async function localAccountsForTargetsInTx(
  tx: Database | DatabaseTransaction,
  targets: readonly AccountTarget[],
) {
  const addresses = await Promise.all(
    targets.map((target) => accountAddressInTx(tx, target)),
  );
  const local = addresses
    .filter((identity) => identity.domain === 'local')
    .map((identity) => identity.account);
  if (!local.length) return [];
  return tx
    .select({
      id: account.id,
      account: account.account,
      domain: account.domain,
      namespaceId: account.namespaceId,
      availability: account.availability,
    })
    .from(account)
    .where(inArray(account.account, [...new Set(local)]))
    .orderBy(account.id);
}
