import { eq, inArray } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransaction,
} from '../database/database.service.js';
import { account, identityNamespace } from '../database/schema.js';

/** A persisted subject address without the transport domain. Local subjects are
 * identified by `namespaceId: 0`; foreign subjects by a positive `namespaceId`
 * allocated to the subject's home server. */
export interface AccountSubjectAddress {
  account: string;
  namespaceId: number;
}

/** Internal commands may identify their local actor by Account.id; foreign
 * subjects use a namespace-scoped address without a transport domain. */
export type AccountTarget = number | AccountSubjectAddress;

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
    typeof identity.namespaceId !== 'number' ||
    !Number.isSafeInteger(identity.namespaceId) ||
    identity.namespaceId < 0
  )
    throw new Error('invalid addressed account target');
  return {
    account: identity.account,
    namespaceId: identity.namespaceId,
  };
}

export async function accountAddressInTx(
  tx: Database | DatabaseTransaction,
  target: AccountTarget,
): Promise<AccountSubjectAddress> {
  if (typeof target !== 'number') return target;
  const local = await tx.query.account.findFirst({
    where: eq(account.id, target),
    columns: { account: true },
  });
  if (!local) throw new Error('local account does not exist');
  return { account: local.account, namespaceId: 0 };
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
    .filter((identity) => identity.namespaceId === 0)
    .map((identity) => identity.account);
  if (!local.length) return [];
  return tx
    .select({
      id: account.id,
      account: account.account,
      domain: identityNamespace.domain,
      namespaceId: account.namespaceId,
      availability: account.availability,
    })
    .from(account)
    .innerJoin(identityNamespace, eq(identityNamespace.id, 0))
    .where(inArray(account.account, [...new Set(local)]))
    .orderBy(account.id);
}
