import {
  accountAddressInTx,
  type AccountTarget,
} from '../../user/account-address.js';
import { sql, type SQLWrapper } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransaction,
} from '../../database/database.service.js';

type QueryExecutor = Database | DatabaseTransaction;

export const relationshipEndpointMatchesUserSql = (
  pairAlias: SQLWrapper,
  side: 'A' | 'B',
  identityAlias: SQLWrapper,
) => {
  const prefix = side === 'A' ? 'endpointA' : 'endpointB';
  return sql`${pairAlias}.${sql.identifier(`${prefix}Type`)} = 'USER'
    AND ${pairAlias}.${sql.identifier(`${prefix}Account`)} = ${identityAlias}.account
    AND ${pairAlias}.${sql.identifier(`${prefix}NamespaceId`)} = ${identityAlias}."namespaceId"`;
};

export const relationshipPairMatchesUsersSql = (
  pairAlias: SQLWrapper,
  firstIdentityAlias: SQLWrapper,
  secondIdentityAlias: SQLWrapper,
) => sql`((
    ${relationshipEndpointMatchesUserSql(pairAlias, 'A', firstIdentityAlias)}
    AND ${relationshipEndpointMatchesUserSql(pairAlias, 'B', secondIdentityAlias)}
  ) OR (
    ${relationshipEndpointMatchesUserSql(pairAlias, 'B', firstIdentityAlias)}
    AND ${relationshipEndpointMatchesUserSql(pairAlias, 'A', secondIdentityAlias)}
  ))`;

export async function isThreadMutuallyAuthorized(
  db: QueryExecutor,
  userId: AccountTarget,
  threadId: number,
): Promise<boolean> {
  return threadRelationshipExists(db, userId, threadId, true);
}

/** A retained relationship allows delivery of a committed departure boundary. */
export async function hasEstablishedThreadRelationship(
  db: QueryExecutor,
  userId: AccountTarget,
  threadId: number,
): Promise<boolean> {
  return threadRelationshipExists(db, userId, threadId, false);
}

async function threadRelationshipExists(
  db: QueryExecutor,
  userId: AccountTarget,
  threadId: number,
  activeOnly: boolean,
): Promise<boolean> {
  const identity = await accountAddressInTx(db, userId);
  const result = await db.execute<{ authorized: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM "RelationshipPair" pair
      JOIN (SELECT ${identity.account}::text AS account,
        ${identity.namespaceId}::integer AS "namespaceId") identity ON true
      WHERE pair."threadId" = ${threadId}
        AND CASE WHEN ${activeOnly} THEN pair.active ELSE pair.established END
        AND (
          (${relationshipEndpointMatchesUserSql(sql`pair`, 'A', sql`identity`)})
          OR (${relationshipEndpointMatchesUserSql(sql`pair`, 'B', sql`identity`)})
        )
    ) AS authorized
  `);
  return result.rows[0]?.authorized ?? false;
}
