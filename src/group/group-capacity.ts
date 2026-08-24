import { sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseTransaction } from '../database/database.service.js';

/**
 * Capacity policy of this SOMS server. It is deliberately not part of the S2S
 * protocol: another implementation may choose a different origin-group limit.
 */
export const SERVER_MAX_GROUP_MEMBERS = 999;
export const SERVER_GROUP_FULL_REASON = `Group invitations, including pending invitations, have reached this server's ${SERVER_MAX_GROUP_MEMBERS}-person limit.`;

/**
 * Serialize joins at the origin group and reserve one local membership slot.
 * Existing locally authorized members consume no new slot, which keeps retries idempotent. The
 * origin reserves capacity when it authors REQUESTED; member acceptance is deliberately irrelevant.
 */
export async function assertServerGroupCapacityInTx(
  tx: DatabaseTransaction,
  threadId: number,
  memberUserId: number,
): Promise<void> {
  const locked = await tx.execute<{ groupUserId: number }>(sql`
    SELECT g."groupUserId"
    FROM "Group" g
    JOIN "MessageThread" thread ON thread."groupUserId" = g."groupUserId"
    WHERE thread.id = ${threadId}
    FOR UPDATE OF g
  `);
  if (locked.rows.length === 0) {
    throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
  }

  const state = await tx.execute<{
    authorizedCount: string | number;
    alreadyAuthorized: boolean;
  }>(sql`
    SELECT
      COUNT(*) AS "authorizedCount",
      COALESCE(BOOL_OR(
        intent."subjectUserId" = ${memberUserId}
      ), false) AS "alreadyAuthorized"
    FROM "RelationshipIntent" intent
    WHERE intent."authorUserId" = ${locked.rows[0].groupUserId}
      AND (intent.status = 'ACCEPTED'
        OR (intent.status = 'REQUESTED'
          AND intent."expiresAt" > CURRENT_TIMESTAMP))
  `);
  const authorizedCount = Number(state.rows[0]?.authorizedCount ?? 0);
  if (
    !state.rows[0]?.alreadyAuthorized &&
    authorizedCount >= SERVER_MAX_GROUP_MEMBERS
  ) {
    throw new BusinessException(
      BusinessCode.GROUP_FULL,
      `group invitations, including pending invitations, have reached the ${SERVER_MAX_GROUP_MEMBERS}-person limit`,
    );
  }
}
