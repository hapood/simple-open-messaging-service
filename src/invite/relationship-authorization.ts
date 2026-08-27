import { sql, type SQLWrapper } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransaction,
} from '../database/database.service.js';

type QueryExecutor = Database | DatabaseTransaction;

const endpointMatchesUserSql = (
  pairAlias: SQLWrapper,
  side: 'A' | 'B',
  identityAlias: SQLWrapper,
) => {
  const prefix = side === 'A' ? 'endpointA' : 'endpointB';
  return sql`${pairAlias}.${sql.identifier(`${prefix}Type`)} = 'USER'
    AND ${pairAlias}.${sql.identifier(`${prefix}Account`)} = ${identityAlias}.account
    AND ${pairAlias}.${sql.identifier(`${prefix}Domain`)} = ${identityAlias}.domain`;
};

/** One directed intent for a fixed Pair endpoint. This is request/one-way authority only. */
export const effectiveRelationshipIntentSql = (
  authorUserId: SQLWrapper | number,
  subjectUserId: SQLWrapper | number,
) => sql`EXISTS (
  SELECT 1
  FROM "RelationshipPair" pair
  JOIN "User" author_identity ON author_identity.id = ${authorUserId}
  JOIN "User" subject_identity ON subject_identity.id = ${subjectUserId}
  JOIN "RelationshipIntent" intent ON intent."pairId" = pair.id
  WHERE (
      (${endpointMatchesUserSql(sql`pair`, 'A', sql`author_identity`)}
       AND ${endpointMatchesUserSql(sql`pair`, 'B', sql`subject_identity`)}
       AND intent."authorSide" = 'A')
      OR
      (${endpointMatchesUserSql(sql`pair`, 'B', sql`author_identity`)}
       AND ${endpointMatchesUserSql(sql`pair`, 'A', sql`subject_identity`)}
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
  JOIN "User" first_identity ON first_identity.id = ${firstUserId}
  JOIN "User" second_identity ON second_identity.id = ${secondUserId}
  WHERE pair.active = true
    AND ((
      ${endpointMatchesUserSql(sql`pair`, 'A', sql`first_identity`)}
      AND ${endpointMatchesUserSql(sql`pair`, 'B', sql`second_identity`)}
    ) OR (
      ${endpointMatchesUserSql(sql`pair`, 'B', sql`first_identity`)}
      AND ${endpointMatchesUserSql(sql`pair`, 'A', sql`second_identity`)}
    ))
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
  userId: number,
  threadId: number,
): Promise<boolean> {
  const result = await db.execute<{ authorized: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM "RelationshipPair" pair
      JOIN "User" identity ON identity.id = ${userId}
      WHERE pair."threadId" = ${threadId}
        AND pair.active = true
        AND (
          (${endpointMatchesUserSql(sql`pair`, 'A', sql`identity`)})
          OR (${endpointMatchesUserSql(sql`pair`, 'B', sql`identity`)})
        )
    ) AS authorized
  `);
  return result.rows[0]?.authorized ?? false;
}
