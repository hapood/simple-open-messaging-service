import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { messageThread } from '../database/schema.js';

/** Owns the thread-wide lower visibility boundary for retained messages. */
@Injectable()
export class ThreadHistoryService {
  constructor(private readonly database: DatabaseService) {}

  async clear(threadId: number, seq?: number): Promise<void> {
    const thread = await this.database.db.query.messageThread.findFirst({
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
    await this.database.db
      .update(messageThread)
      .set({
        clearedSeq: sql`GREATEST(COALESCE(${messageThread.clearedSeq}, 0), ${seq ?? thread.curSeq})`,
        updatedAt: new Date(),
      })
      .where(eq(messageThread.id, threadId));
  }
}
