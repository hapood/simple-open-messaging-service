import { sql } from 'drizzle-orm';
import {
  insertPendingTaskInTx,
  updatePendingTaskInTx,
} from '../durable-task/task-admission.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import type { MarkReadDto } from '../dto/message.dto.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { Logger } from '@nestjs/common';
import { requireThreadContentLockInTx } from '../business/shared/locks/thread-content-lock.js';
import {
  ThreadFeedHeadWriter,
  readPositionInterval,
} from './thread-feed-head.writer.js';

const logger = new Logger('ThreadReadPosition');

/** Admit read intent in the caller's source transaction; never wait for execution. */
export async function enqueueReadPositionInTx(
  tx: DatabaseTransaction,
  accountId: number,
  request: MarkReadDto,
) {
  await requireThreadContentLockInTx(tx, request.threadId);
  // Preserve intent across pending force barriers; resolve again at execution.
  await resolveReadPositionInTx(tx, accountId, request);
  const scope = JSON.stringify(['ATTENTION', accountId, request.threadId]);
  const last = await tx.execute<{
    id: string;
    status: string;
    payload: MarkReadDto;
  }>(sql`
    SELECT id::text, status, payload FROM "DurableTask"
    WHERE kind = 'MUTATION' AND "scopeKey" = ${scope}
    ORDER BY id DESC LIMIT 1 FOR NO KEY UPDATE`);
  const pending = last.rows[0];
  if (
    !request.force &&
    pending?.status === 'PENDING' &&
    !pending.payload.force
  ) {
    const updated = await updatePendingTaskInTx(tx, BigInt(pending.id), {
      payload: {
        threadId: request.threadId,
        localReadHwm: Math.max(
          request.localReadHwm,
          pending.payload.localReadHwm,
        ),
        force: false,
      },
    });
    if (!updated) throw new Error('locked read-position pending task changed');
    return { taskId: pending.id, status: 'PENDING' as const };
  }
  const inserted = await insertPendingTaskInTx(tx, {
    kind: 'MUTATION',
    scopeType: 'ACCOUNT_THREAD',
    scopeKey: scope,
    taskType: DurableTaskType.COMMIT_THREAD_READ_POSITION,
    actorUserId: accountId,
    payload: { ...request, force: request.force ?? false },
    coalescingKey: scope,
  });
  return { taskId: inserted.taskId.toString(), status: 'PENDING' as const };
}

/** Caller holds the thread content lock, shared with history-gap mutations. */
export async function resolveReadPositionInTx(
  tx: DatabaseTransaction,
  accountId: number,
  request: MarkReadDto,
): Promise<number> {
  const result = await tx.execute<{
    bound: number;
    lastReadSeq: number;
    minimumReadSeq: number;
  }>(sql`
    SELECT visible.bound, s."lastReadSeq",
      COALESCE((
        SELECT max(LEAST(g."endSeq"::bigint + g."messageSeqOffset", visible.bound))::integer
        FROM "FederationThreadHistoryGap" g
        JOIN "IdentityNamespace" ns ON ns.id = g."namespaceId"
        WHERE g."threadId" = t.id AND g.recoverable = true
          AND ns."retiredAt" IS NULL
          AND (ns.id = 0 OR EXISTS (
            SELECT 1 FROM "FederatedPeer" p
            WHERE p.domain = ns.domain AND p."activeNamespaceId" = ns.id
          ))
          AND g."startSeq"::bigint + g."messageSeqOffset" <= visible.bound
          AND g."endSeq"::bigint + g."messageSeqOffset" > COALESCE(t."clearedSeq", 0)
      ), 0) AS "minimumReadSeq"
    FROM "AccountThreadState" s JOIN "MessageThread" t ON t.id = s."threadId"
    JOIN "Account" a ON a.id = s."accountId" AND a.availability = 'AVAILABLE'
    CROSS JOIN LATERAL (
      SELECT LEAST(t."curSeq", COALESCE(s."messageVisibleThroughSeq", t."curSeq"))::integer AS bound
    ) visible
    WHERE s."accountId" = ${accountId} AND s."threadId" = ${request.threadId}`);
  if (!result.rows[0])
    throw new BusinessException(
      BusinessCode.THREAD_NOT_FOUND,
      'thread not found',
    );
  if (!Number.isInteger(request.localReadHwm) || request.localReadHwm < 0)
    throw new BusinessException(
      BusinessCode.VALIDATION_FAILED,
      'read position must be a nonnegative integer',
    );
  const requestedReadSeq = Math.min(request.localReadHwm, result.rows[0].bound);
  if (requestedReadSeq !== request.localReadHwm) {
    logger.debug(
      `Clamp read position for account ${accountId}, thread ${request.threadId}: ${request.localReadHwm} -> ${requestedReadSeq} (visible upper boundary)`,
    );
  }
  const effectiveReadSeq = request.force
    ? requestedReadSeq
    : Math.max(result.rows[0].lastReadSeq, requestedReadSeq);
  if (effectiveReadSeq < result.rows[0].minimumReadSeq) {
    logger.debug(
      `Clamp read position for account ${accountId}, thread ${request.threadId}: ${effectiveReadSeq} -> ${result.rows[0].minimumReadSeq} (recoverable history boundary)`,
    );
    return result.rows[0].minimumReadSeq;
  }
  return effectiveReadSeq;
}

/** Caller holds the content lock. The writer owns deltas; the trigger allocates the feed ID. */
export async function applyReadPositionInTx(
  tx: DatabaseTransaction,
  accountId: number,
  request: MarkReadDto,
): Promise<number> {
  const localReadHwm = await resolveReadPositionInTx(tx, accountId, request);
  const state = await ThreadFeedHeadWriter.readStateInTx(
    tx,
    accountId,
    request.threadId,
  );
  if (!state) throw new Error('Read projection state disappeared');
  const lastMentionSeq = await ThreadFeedHeadWriter.resolveMentionInTx(
    tx,
    accountId,
    request.threadId,
    state,
    {
      lastReadSeq: localReadHwm,
      messageEndSeq: state.messageEndSeq,
      tombstoneEndSeq: state.tombstoneEndSeq,
    },
  );
  const unreadCount =
    state.unreadCount +
    (await ThreadFeedHeadWriter.unreadDeltaInTx(
      tx,
      accountId,
      request.threadId,
      readPositionInterval(
        state.lastReadSeq,
        localReadHwm,
        state.messageEndSeq,
      ),
    ));
  const previewSeqs = await ThreadFeedHeadWriter.previewSeqsInTx(
    tx,
    accountId,
    request.threadId,
    state,
    {
      lastReadSeq: localReadHwm,
      messageEndSeq: state.messageEndSeq,
    },
  );
  const result = await tx.execute<{ lastReadSeq: number }>(sql`
    UPDATE "AccountThreadState" SET "lastReadSeq" =
      CASE WHEN ${request.force === true} THEN ${localReadHwm}
        ELSE GREATEST("lastReadSeq", ${localReadHwm}) END,
      "unreadCount" = ${unreadCount},
      "previewSeqs" = ${sql.param(previewSeqs)}::integer[],
      "lastMentionSeq" = ${lastMentionSeq}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "accountId" = ${accountId} AND "threadId" = ${request.threadId}
    RETURNING "lastReadSeq"`);
  return result.rows[0].lastReadSeq;
}
