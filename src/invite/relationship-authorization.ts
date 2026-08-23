import { sql, type SQLWrapper } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransaction,
} from '../database/database.service.js';

type QueryExecutor = Database | DatabaseTransaction;

/** One direction grants authorization while accepted or while its request TTL is still live. */
export const effectiveRelationshipIntentSql = (
  authorUserId: SQLWrapper | number,
  subjectUserId: SQLWrapper | number,
) => sql`EXISTS (
  SELECT 1 FROM "RelationshipIntent" authorization
  WHERE authorization."authorUserId" = ${authorUserId}
    AND authorization."subjectUserId" = ${subjectUserId}
    AND (authorization.status = 'ACCEPTED'
      OR (authorization.status = 'REQUESTED'
        AND authorization."expiresAt" > CURRENT_TIMESTAMP))
)`;

/** Current write/member authority requires a live grant in both authored directions. */
export const mutuallyAuthorizedSql = (
  firstUserId: SQLWrapper | number,
  secondUserId: SQLWrapper | number,
) => sql`(
  ${effectiveRelationshipIntentSql(firstUserId, secondUserId)}
  AND ${effectiveRelationshipIntentSql(secondUserId, firstUserId)}
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

/** Resolve the relationship pair represented by a participant row and evaluate both directions. */
export async function isThreadMutuallyAuthorized(
  db: QueryExecutor,
  userId: number,
  threadId: number,
): Promise<boolean> {
  const result = await db.execute<{ authorized: boolean }>(sql`
    SELECT CASE thread.type
      WHEN 'P2P' THEN EXISTS (
        SELECT 1
        FROM "ThreadParticipant" peer
        WHERE peer."threadId" = thread.id
          AND peer."userId" <> ${userId}
          AND ${mutuallyAuthorizedSql(userId, sql`peer."userId"`)}
      )
      WHEN 'GROUP' THEN thread."groupUserId" IS NOT NULL
        AND ${mutuallyAuthorizedSql(userId, sql`thread."groupUserId"`)}
      ELSE false
    END AS authorized
    FROM "MessageThread" thread
    JOIN "ThreadParticipant" mine
      ON mine."threadId" = thread.id AND mine."userId" = ${userId}
    WHERE thread.id = ${threadId}
  `);
  return result.rows[0]?.authorized ?? false;
}
