import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { callHistory, message, messageThread } from '../database/schema.js';
import { ContentType } from '../database/enums.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { requireThreadContentLockInTx } from '../relationship/thread-content-lock.js';
import { enqueueThreadFanoutInTx } from '../message/thread-fanout-task.js';
import {
  type CallEndedContent,
  parseCallEndedContent,
} from '../../shared/call-ended-content.js';

export interface CallHistorySnapshot {
  key: string;
  threadId: number;
  revision: number;
  content: CallEndedContent;
}

@Injectable()
export class CallHistoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallHistoryService.name);
  private readonly pending = new Map<string, CallHistorySnapshot>();
  private retryTimer?: ReturnType<typeof setInterval>;
  private retrying = false;
  constructor(private readonly database: DatabaseService) {}

  /** Admission and observations are durable before their successful acknowledgement. */
  async observe(snapshot: CallHistorySnapshot): Promise<void> {
    const admitted = await this.database.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, snapshot.threadId);
      return tx
        .insert(callHistory)
        .values({
          key: snapshot.key,
          threadId: snapshot.threadId,
          revision: snapshot.revision,
          snapshot: { ...snapshot.content },
        })
        .onConflictDoUpdate({
          target: callHistory.key,
          set: {
            revision: snapshot.revision,
            snapshot: { ...snapshot.content },
          },
          setWhere: and(
            eq(callHistory.terminal, false),
            sql`${callHistory.revision} < ${snapshot.revision}`,
          ),
        })
        .returning({ key: callHistory.key });
    });
    if (snapshot.revision === 1 && admitted.length === 0)
      throw new BusinessException(
        BusinessCode.CALL_TERMINATED,
        'call identifier already used',
      );
  }

  /** One terminal notice and its device fanout share the durable terminal decision. */
  async finish(input: CallHistorySnapshot): Promise<void> {
    const snapshot = this.pending.get(input.key) ?? input;
    const content = parseCallEndedContent(JSON.stringify(snapshot.content));
    if (!content || content.initiatedAt === undefined)
      throw new Error('invalid terminal call observation');
    this.pending.set(snapshot.key, snapshot);
    // Commit the journal independently, but acquire parents before child/FK locks.
    await this.database.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, snapshot.threadId);
      await tx
        .insert(callHistory)
        .values({
          key: snapshot.key,
          threadId: snapshot.threadId,
          revision: snapshot.revision,
          snapshot: { ...content },
          terminal: true,
        })
        .onConflictDoUpdate({
          target: callHistory.key,
          set: {
            snapshot: { ...content },
            revision: snapshot.revision,
            terminal: true,
          },
          setWhere: eq(callHistory.terminal, false),
        });
    });
    await this.database.db.transaction(async (tx) => {
      const lock = await requireThreadContentLockInTx(tx, snapshot.threadId);
      const [existing] = await tx
        .select()
        .from(callHistory)
        .where(eq(callHistory.key, snapshot.key))
        .for('update');
      if (!existing || !existing.terminal)
        throw new Error('terminal call journal is missing');
      if (existing.messageSeq !== null) return;
      const terminalContent = parseCallEndedContent(
        JSON.stringify(existing.snapshot),
      );
      if (!terminalContent) throw new Error('invalid journaled terminal call');
      const [{ seq, tombstoneEndSeq }] = await tx
        .update(messageThread)
        .set({
          curSeq: sql`${messageThread.curSeq} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(messageThread.id, snapshot.threadId))
        .returning({
          seq: messageThread.curSeq,
          tombstoneEndSeq: messageThread.deletionSeqAllocatedThrough,
        });
      await tx.insert(message).values({
        threadId: snapshot.threadId,
        seq,
        contentType: ContentType.SYSTEM,
        content: JSON.stringify(terminalContent),
        updatedAt: new Date(),
      });
      await tx
        .update(callHistory)
        .set({
          terminal: true,
          snapshot: { ...terminalContent },
          messageSeq: seq,
        })
        .where(eq(callHistory.key, snapshot.key));
      await enqueueThreadFanoutInTx(tx, lock, {
        threadId: snapshot.threadId,
        messageEndSeq: seq,
        tombstoneEndSeq,
      });
    });
    this.pending.delete(snapshot.key);
  }

  /** Live media cannot survive a process restart; preserve one interrupted-call notice. */
  async onModuleInit(): Promise<void> {
    const pending = await this.database.db
      .select()
      .from(callHistory)
      .where(isNull(callHistory.messageSeq));
    for (const row of pending) {
      const previous = row.snapshot as unknown as CallEndedContent;
      await this.tryFinish({
        key: row.key,
        threadId: row.threadId,
        revision: row.revision + 1,
        content: row.terminal
          ? previous
          : {
              ...previous,
              outcome: 'failed',
              endedAt: Math.max(
                Date.now(),
                previous.connectedAt ?? previous.initiatedAt ?? 0,
              ),
            },
      });
    }
    this.retryTimer = setInterval(() => {
      void this.retryPending();
    }, 5000);
    this.retryTimer.unref();
  }

  private async retryPending(): Promise<void> {
    if (this.retrying) return;
    this.retrying = true;
    try {
      const attempted = new Set(this.pending.keys());
      for (const snapshot of [...this.pending.values()])
        await this.tryFinish(snapshot);
      const rows = await this.database.db
        .select()
        .from(callHistory)
        .where(
          and(eq(callHistory.terminal, true), isNull(callHistory.messageSeq)),
        );
      for (const row of rows) {
        if (attempted.has(row.key)) continue;
        await this.tryFinish({
          key: row.key,
          threadId: row.threadId,
          revision: row.revision,
          content: row.snapshot as unknown as CallEndedContent,
        });
      }
    } catch (error) {
      this.logger.error(
        'Terminal call history remains pending for retry',
        error,
      );
    } finally {
      this.retrying = false;
    }
  }

  private async tryFinish(snapshot: CallHistorySnapshot): Promise<void> {
    try {
      await this.finish(snapshot);
    } catch (error) {
      this.logger.error(
        `Terminal call history ${snapshot.key} remains pending for retry`,
        error,
      );
    }
  }

  onModuleDestroy(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }
}
