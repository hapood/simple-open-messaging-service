import { sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseTransaction } from '../database/database.service.js';

/**
 * Capacity policy of this SOMS server. It is deliberately not part of the S2S
 * protocol: another implementation may choose a different origin-group limit.
 */
export const SERVER_MAX_GROUP_MEMBERS = 999;
export const SERVER_GROUP_FULL_REASON = `Group has reached this server's ${SERVER_MAX_GROUP_MEMBERS}-member limit.`;

/**
 * Serialize joins at the origin group and reserve one local membership slot.
 * Existing active members consume no new slot, which keeps retries idempotent.
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
    activeCount: string | number;
    alreadyActive: boolean;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE participant.state = 'ESTABLISHED') AS "activeCount",
      COALESCE(BOOL_OR(
        participant."userId" = ${memberUserId}
        AND participant.state = 'ESTABLISHED'
      ), false) AS "alreadyActive"
    FROM "ThreadParticipant" participant
    WHERE participant."threadId" = ${threadId}
  `);
  const activeCount = Number(state.rows[0]?.activeCount ?? 0);
  if (
    !state.rows[0]?.alreadyActive &&
    activeCount >= SERVER_MAX_GROUP_MEMBERS
  ) {
    throw new BusinessException(
      BusinessCode.GROUP_FULL,
      `this server limits groups to ${SERVER_MAX_GROUP_MEMBERS} members`,
    );
  }
}
