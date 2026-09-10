import {
  accountAddressInTx,
  type AccountTarget,
} from '../user/account-address.js';
import { sql, type SQLWrapper } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransaction,
} from '../database/database.service.js';

type QueryExecutor = Database | DatabaseTransaction;

export const relationshipEndpointMatchesUserSql = (
  pairAlias: SQLWrapper,
  side: 'A' | 'B',
  identityAlias: SQLWrapper,
) => {
  const prefix = side === 'A' ? 'endpointA' : 'endpointB';
  return sql`${pairAlias}.${sql.identifier(`${prefix}Type`)} = 'USER'
    AND ${pairAlias}.${sql.identifier(`${prefix}Account`)} = ${identityAlias}.account
    AND ${pairAlias}.${sql.identifier(`${prefix}Domain`)} = ${identityAlias}.domain
    AND (${identityAlias}."namespaceId" = 0
      OR ${pairAlias}.${sql.identifier(`${prefix}NamespaceId`)} = ${identityAlias}."namespaceId")`;
};

const pairNamespaceMatchesUsersSql = (
  pairAlias: SQLWrapper,
  firstIdentityAlias: SQLWrapper,
  secondIdentityAlias: SQLWrapper,
) => sql`${pairAlias}."endpointANamespaceId" = ${pairAlias}."endpointBNamespaceId"
  AND ${pairAlias}."endpointANamespaceId" = CASE
    WHEN ${firstIdentityAlias}."namespaceId" <> 0
      THEN ${firstIdentityAlias}."namespaceId"
    ELSE ${secondIdentityAlias}."namespaceId"
  END`;

export const relationshipPairMatchesUsersSql = (
  pairAlias: SQLWrapper,
  firstIdentityAlias: SQLWrapper,
  secondIdentityAlias: SQLWrapper,
) => sql`${pairNamespaceMatchesUsersSql(pairAlias, firstIdentityAlias, secondIdentityAlias)}
  AND ((
    ${relationshipEndpointMatchesUserSql(pairAlias, 'A', firstIdentityAlias)}
    AND ${relationshipEndpointMatchesUserSql(pairAlias, 'B', secondIdentityAlias)}
  ) OR (
    ${relationshipEndpointMatchesUserSql(pairAlias, 'B', firstIdentityAlias)}
    AND ${relationshipEndpointMatchesUserSql(pairAlias, 'A', secondIdentityAlias)}
  ))`;

/** One directed intent for a fixed Pair endpoint. This is request/one-way authority only. */
export const effectiveRelationshipIntentSql = (
  authorUserId: SQLWrapper | number,
  subjectUserId: SQLWrapper | number,
) => sql`EXISTS (
  SELECT 1
  FROM "RelationshipPair" pair
  JOIN "Account" author_identity ON author_identity.id = ${authorUserId}
  JOIN "Account" subject_identity ON subject_identity.id = ${subjectUserId}
  JOIN "RelationshipIntent" intent ON intent."pairId" = pair.id
  WHERE ${pairNamespaceMatchesUsersSql(sql`pair`, sql`author_identity`, sql`subject_identity`)}
    AND (
      (${relationshipEndpointMatchesUserSql(sql`pair`, 'A', sql`author_identity`)}
       AND ${relationshipEndpointMatchesUserSql(sql`pair`, 'B', sql`subject_identity`)}
       AND intent."authorSide" = 'A')
      OR
      (${relationshipEndpointMatchesUserSql(sql`pair`, 'B', sql`author_identity`)}
       AND ${relationshipEndpointMatchesUserSql(sql`pair`, 'A', sql`subject_identity`)}
       AND intent."authorSide" = 'B')
    )
    AND (intent.status = 'ACCEPTED'
      OR (intent.status = 'REQUESTED' AND intent."expiresAt" > CURRENT_TIMESTAMP))
)`;

/** Mutual authorization is a materialized Pair fact, never inferred from Participant or Intent. */
export const mutuallyAuthorizedSql = (
  firstUserId: SQLWrapper | number,
  secondUserId: SQLWrapper | number,
) => sql`EXISTS (
  SELECT 1
  FROM "RelationshipPair" pair
  JOIN "Account" first_identity ON first_identity.id = ${firstUserId}
  JOIN "Account" second_identity ON second_identity.id = ${secondUserId}
  WHERE pair.active = true
    AND ${relationshipPairMatchesUsersSql(sql`pair`, sql`first_identity`, sql`second_identity`)}
)`;

export async function isPairMutuallyAuthorized(
  db: QueryExecutor,
  firstUserId: number,
  secondUserId: number,
): Promise<boolean> {
  const result = await db.execute<{ authorized: boolean }>(sql`
    SELECT ${mutuallyAuthorizedSql(firstUserId, secondUserId)} AS authorized
  `);
  return result.rows[0]?.authorized ?? false;
}

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
      JOIN (SELECT ${identity.account}::text AS account, ${identity.domain}::text AS domain,
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
