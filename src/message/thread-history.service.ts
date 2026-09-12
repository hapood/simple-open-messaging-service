import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { requireThreadContentLockInTx } from '../business/shared/locks/thread-content-lock.js';
import { messageThread } from '../database/schema.js';
import { ThreadFeedHeadWriter } from './thread-feed-head.writer.js';

/** Owns the thread-wide lower visibility boundary for retained messages. */
@Injectable()
export class ThreadHistoryService {
  constructor(private readonly database: DatabaseService) {}

  async clear(threadId: number, seq?: number): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, threadId);
      const thread = await tx.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
        columns: { curSeq: true },
      });
      if (!thread) {
        throw new BusinessException(
          BusinessCode.THREAD_NOT_FOUND,
          'thread not found',
        );
      }
      if (seq !== undefined && seq > thread.curSeq) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'seq must not exceed the thread current sequence',
        );
      }
      await tx
        .update(messageThread)
        .set({
          clearedSeq: sql`GREATEST(COALESCE(${messageThread.clearedSeq}, 0), ${seq ?? thread.curSeq})`,
          updatedAt: new Date(),
        })
        .where(eq(messageThread.id, threadId));
      const states = await tx.execute<{
        accountId: number;
        messageEndSeq: number;
        tombstoneEndSeq: number;
      }>(sql`
        SELECT "accountId", "messageEndSeq", "tombstoneEndSeq"
        FROM "AccountThreadState" WHERE "threadId" = ${threadId} ORDER BY "accountId"`);
      for (const state of states.rows) {
        await ThreadFeedHeadWriter.advanceInTx(tx, state.accountId, {
          threadId,
          ...state,
        });
      }
    });
  }
}
