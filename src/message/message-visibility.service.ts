import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  message,
  messageThread,
  threadParticipant,
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
        clearedSeq: threadParticipant.clearedSeq,
        leftSeq: threadParticipant.leftSeq,
        blocked: threadParticipant.blocked,
      })
      .from(message)
      .innerJoin(
        threadParticipant,
        and(
          eq(threadParticipant.threadId, message.threadId),
          eq(threadParticipant.userId, userId),
        ),
      )
      .innerJoin(messageThread, eq(messageThread.id, message.threadId))
      .where(
        and(
          eq(message.threadId, threadId),
          eq(message.seq, seq),
          eq(message.isDeleted, false),
          sql`${message.seq} > COALESCE(${threadParticipant.clearedSeq}, 0)`,
          sql`${threadParticipant.leftSeq} IS NULL OR ${message.seq} <= ${threadParticipant.leftSeq}`,
        ),
      )
      .limit(1);
    if (!row) return null;

    if (row.threadType === MessageThreadType.P2P && row.blocked) return null;
    return row.message;
  }
}
