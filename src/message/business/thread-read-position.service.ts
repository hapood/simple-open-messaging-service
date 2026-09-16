import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../../common/business-code.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../../database/database.service.js';
import type { MarkReadDto } from '../../dto/message.dto.js';
import { SseService } from '../../gateway/sse.service.js';
import {
  acquireThreadContentLockInTx,
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../../common/business/locks/thread-content-lock.js';
import {
  type BusinessRejection,
  rejectBusinessCommand,
} from '../../common/business/business-command-result.js';
import {
  ThreadFeedHeadWriter,
  readPositionInterval,
} from '../thread-feed-head.writer.js';
import { MeasureBusinessOperation } from '../../diagnostics/execution-measurement.js';

const logger = new Logger('ThreadReadPositionService');

export type ThreadReadPositionResult =
  | { status: 'APPLIED'; lastReadSeq: number }
  | BusinessRejection;

/** Synchronously commits one local account's viewport read position. */
@Injectable()
export class ThreadReadPositionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sse: SseService,
  ) {}

  @MeasureBusinessOperation('message.mark-read')
  async execute(
    accountId: number,
    request: MarkReadDto,
  ): Promise<ThreadReadPositionResult> {
    if (!Number.isInteger(request.localReadHwm) || request.localReadHwm < 0)
      return rejectBusinessCommand(
        'INVALID_READ_POSITION',
        BusinessCode.VALIDATION_FAILED,
        'read position must be a nonnegative integer',
      );
    const committed = await this.database.db.transaction(async (tx) => {
      const threadLock = await acquireThreadContentLockInTx(
        tx,
        request.threadId,
      );
      if (!threadLock)
        return { applied: false as const, outcome: threadNotFound() };
      const lastReadSeq = await tryApplyReadPositionInTx(
        tx,
        threadLock,
        accountId,
        request,
      );
      if (lastReadSeq === undefined)
        return { applied: false as const, outcome: threadNotFound() };
      const head = await tx.execute<{ threadFeedEndId: number }>(sql`
        SELECT "threadFeedEndId" FROM "Account" WHERE id = ${accountId}`);
      if (!head.rows[0])
        throw new Error('Read-position account disappeared while locked');
      return {
        applied: true as const,
        outcome: { status: 'APPLIED' as const, lastReadSeq },
        threadFeedEndId: head.rows[0].threadFeedEndId,
      };
    });
    if (committed.applied) {
      this.sse.onThreadFeedUpdated(accountId, {
        threadFeedEndId: committed.threadFeedEndId,
      });
    }
    return committed.outcome;
  }
}

function threadNotFound(): BusinessRejection {
  return rejectBusinessCommand(
    'THREAD_NOT_FOUND',
    BusinessCode.THREAD_NOT_FOUND,
    'thread not found',
  );
}

/** Resolve the effective cursor while the caller holds the thread content lock. */
async function resolveReadPositionInTx(
  tx: DatabaseTransaction,
  accountId: number,
  request: MarkReadDto,
): Promise<number | undefined> {
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
  const row = result.rows[0];
  if (!row) return undefined;
  const requestedReadSeq = Math.min(request.localReadHwm, row.bound);
  if (requestedReadSeq !== request.localReadHwm) {
    logger.debug(
      `Clamp read position for account ${accountId}, thread ${request.threadId}: ${request.localReadHwm} -> ${requestedReadSeq} (visible upper boundary)`,
    );
  }
  const effectiveReadSeq = request.force
    ? requestedReadSeq
    : Math.max(row.lastReadSeq, requestedReadSeq);
  if (effectiveReadSeq < row.minimumReadSeq) {
    logger.debug(
      `Clamp read position for account ${accountId}, thread ${request.threadId}: ${effectiveReadSeq} -> ${row.minimumReadSeq} (recoverable history boundary)`,
    );
    return row.minimumReadSeq;
  }
  return effectiveReadSeq;
}

async function tryApplyReadPositionInTx(
  tx: DatabaseTransaction,
  threadLock: ThreadContentLock,
  accountId: number,
  request: MarkReadDto,
): Promise<number | undefined> {
  await requireThreadContentLockInTx(tx, request.threadId, threadLock);
  const localReadHwm = await resolveReadPositionInTx(tx, accountId, request);
  if (localReadHwm === undefined) return undefined;
  const state = await ThreadFeedHeadWriter.readStateInTx(
    tx,
    accountId,
    request.threadId,
  );
  if (!state) throw new Error('Read projection state disappeared while locked');
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
  if (!result.rows[0])
    throw new Error('Read projection disappeared during locked update');
  return result.rows[0].lastReadSeq;
}

/** Internal projection writers use this only after establishing that the account owns the thread. */
export async function applyReadPositionInTx(
  tx: DatabaseTransaction,
  threadLock: ThreadContentLock,
  accountId: number,
  request: MarkReadDto,
): Promise<number> {
  const result = await tryApplyReadPositionInTx(
    tx,
    threadLock,
    accountId,
    request,
  );
  if (result === undefined)
    throw new Error('Expected read-position projection does not exist');
  return result;
}
