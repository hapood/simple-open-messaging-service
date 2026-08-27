import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';

/** Track the latest authored sequence only for a group hosted by this server. */
export async function recordHostedGroupLastSentSeq(
  tx: DatabaseTransaction,
  threadId: number,
  author: { account: string; domain: string },
  seq: number,
): Promise<void> {
  await tx.execute(sql`
    UPDATE "ThreadMember" member
    SET "lastSentSeq" = ${seq}, "updatedAt" = CURRENT_TIMESTAMP
    FROM "User" author
    WHERE member."threadId" = ${threadId}
      AND member."userId" = author.id
      AND author.account = ${author.account}
      AND author.domain = ${author.domain}
      AND EXISTS (
          SELECT 1
          FROM "MessageThread" thread
          JOIN "Group" group_state ON group_state.id = thread."groupId"
          WHERE thread.id = ${threadId}
            AND thread.type = 'GROUP'
            AND group_state.domain = 'local'
        )
  `);
}
