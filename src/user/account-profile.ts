import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { account } from '../database/schema.js';

/** Default-profile display fields for local account administration and self-profile projections.
 * Message and roster renderers instead select the exact revision on their own reference. */
export function accountProfileFields(
  owner: { account: AnyPgColumn; defaultProfileRev: AnyPgColumn } = account,
) {
  const field = (column: string) => sql<string>`(
    SELECT snapshot.${sql.identifier(column)} FROM "Profile" snapshot
    WHERE snapshot.account = ${owner.account} AND snapshot.domain = 'local'
      AND snapshot."publisherNamespaceId" = 0
      AND snapshot."profileNamespaceId" = 0
      AND snapshot."profileRev" = ${owner.defaultProfileRev}
  )`;
  return {
    name: sql<string>`COALESCE(${field('displayName')}, ${owner.account})`,
    avatar: sql<string>`COALESCE(${field('avatar')}, '')`,
    bio: sql<string>`COALESCE(${field('bio')}, '')`,
  };
}
