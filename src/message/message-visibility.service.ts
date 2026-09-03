import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  message,
  messageThread,
  accountThreadState,
} from '../database/schema.js';
import { MessageThreadType } from '../database/enums.js';

/**
 * The single object-level visibility boundary for user-facing Message lookups.
 * Internal replication, GC and audit code deliberately continue to query Message directly.
 */
@Injectable()
export class MessageVisibilityService {
  constructor(private readonly database: DatabaseService) {}

  async findVisibleByThreadSeq(userId: number, threadId: number, seq: number) {
    const [row] = await this.database.db
      .select({
        message,
        threadType: messageThread.type,
        clearedSeq: messageThread.clearedSeq,
        messageVisibleThroughSeq: accountThreadState.messageVisibleThroughSeq,
        blocked: accountThreadState.blocked,
      })
      .from(message)
      .innerJoin(
        accountThreadState,
        and(
          eq(accountThreadState.threadId, message.threadId),
          eq(accountThreadState.accountId, userId),
        ),
      )
      .innerJoin(messageThread, eq(messageThread.id, message.threadId))
      .where(
        and(
          eq(message.threadId, threadId),
          eq(message.seq, seq),
          eq(message.isDeleted, false),
          sql`${accountThreadState.messageVisibleThroughSeq} IS NULL OR ${message.seq} <= ${accountThreadState.messageVisibleThroughSeq}`,
        ),
      )
      .limit(1);
    if (!row) return null;

    if (
      (row.clearedSeq !== null && seq <= row.clearedSeq) ||
      (row.threadType === MessageThreadType.P2P && row.blocked)
    )
      return null;
    return row.message;
  }
}
