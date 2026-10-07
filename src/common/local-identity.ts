import { eq } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransaction,
} from '../database/database.service.js';
import { identityNamespace } from '../database/schema.js';
import { isValidSomfpDomain } from './account.js';

export const LOCAL_NAMESPACE_ID = 0;

type DatabaseExecutor = Database | DatabaseTransaction;

/**
 * Read the canonical local identity domain from namespace 0. Configuration is
 * only allowed to initialize or re-bind this row during application startup.
 */
export async function localIdentityDomain(
  database: DatabaseExecutor,
): Promise<string> {
  const row = await database.query.identityNamespace.findFirst({
    where: eq(identityNamespace.id, LOCAL_NAMESPACE_ID),
    columns: { domain: true },
  });
  if (!row || !isValidSomfpDomain(row.domain)) {
    throw new Error('local identity namespace is missing or malformed');
  }
  return row.domain;
}

export function isLocalNamespace(namespaceId: number): boolean {
  return namespaceId === LOCAL_NAMESPACE_ID;
}
