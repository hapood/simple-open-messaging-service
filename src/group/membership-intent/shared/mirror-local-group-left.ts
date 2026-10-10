import { eq, sql } from 'drizzle-orm';
import { account } from '../../../database/schema.js';
import type { DatabaseTransaction } from '../../../database/database.service.js';
import {
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../../../common/locks/thread-content-lock.js';
import { threadFanoutAdmissionSql } from '../../../common/sql/thread-content-fanout-admission-sql.js';

/** Announce an active-to-inactive local mirror relationship in the same
 * transaction that consumed or authored its REVOKED intent. The caller holds
 * the group/thread lock and invokes this only when the pair changed. */
export async function writeMirrorLocalGroupLeftInTx(
  tx: DatabaseTransaction,
  input: {
    threadId: number;
    localMemberId: number;
    memberAccount: string;
    threadLock: ThreadContentLock;
  },
): Promise<number> {
  await requireThreadContentLockInTx(tx, input.threadId, input.threadLock);
  const member = await tx.query.account.findFirst({
    where: eq(account.id, input.localMemberId),
    columns: { defaultProfileRev: true },
  });
  if (!member) throw new Error('departing local member is unavailable');
  const content = JSON.stringify({
    type: 'GROUP_LEFT',
    member: {
      account: input.memberAccount,
      profileNamespaceId: 0,
      profileRev: member.defaultProfileRev,
    },
  });
  const accountScope = JSON.stringify([
    'ACCOUNT_THREAD_FANOUT',
    input.threadId,
    input.localMemberId,
  ]);
  const result = await tx.execute<{ seq: number }>(sql`
    WITH seq_alloc AS (
      UPDATE "MessageThread" SET "curSeq" = "curSeq" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${input.threadId}
      RETURNING "curSeq", "tombstoneEndSeq"
    ), system_message AS (
      INSERT INTO "Message" ("threadId", seq, "contentType", content, "creatorAccount", "profileNamespaceId", "publisherNamespaceId", "updatedAt")
      SELECT ${input.threadId}, s."curSeq", 'SYSTEM'::"ContentType",
        ${content}::jsonb, '$system', 0, 0, CURRENT_TIMESTAMP
      FROM seq_alloc s RETURNING seq
    ), member_watermark AS (
      UPDATE "AccountThreadState" state
      SET "messageVisibleThroughSeq" = notice.seq,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM system_message notice
      WHERE state."threadId" = ${input.threadId}
        AND state."accountId" = ${input.localMemberId}
      RETURNING state."accountId"
    ), ${threadFanoutAdmissionSql({
      threadId: input.threadId,
      prefix: 'thread_fanout',
      federation: false,
    })}, departure_task AS (
      INSERT INTO "DurableTask"
        (kind, "scopeType", "scopeKey", "taskType", payload,
          "coalescingKey", status)
      SELECT 'PROJECTION'::"DurableTaskKind",
        'THREAD'::"DurableTaskScopeType", ${accountScope},
        'FAN_OUT_ACCOUNT_THREAD_CONTENT',
        jsonb_build_object('threadId', ${input.threadId}::integer,
          'messageEndSeq', (SELECT seq FROM system_message),
          'tombstoneEndSeq', (SELECT "tombstoneEndSeq" FROM seq_alloc),
          'accountId', ${input.localMemberId}::integer),
        ${accountScope}, 'PENDING'::"DurableTaskStatus"
      WHERE EXISTS (SELECT 1 FROM system_message)
      RETURNING id
    )
    SELECT seq FROM system_message
    CROSS JOIN (SELECT count(*) FROM member_watermark) watermark_barrier
    CROSS JOIN (SELECT count(*) FROM thread_fanout_insert) fanout_barrier
    CROSS JOIN (SELECT count(*) FROM departure_task) departure_barrier
  `);
  const seq = result.rows[0]?.seq;
  if (seq === undefined)
    throw new Error('mirror local departure did not allocate a system message');
  return seq;
}
