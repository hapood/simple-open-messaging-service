import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { ThreadFeedDeltaDto, MarkReadDto } from '../dto/message.dto.js';
import { ThreadPreviewService } from './thread-preview.service.js';
import { deriveMessagePreview } from '../../shared/message-preview.js';
import {
  applyReadPositionInTx,
  enqueueReadPositionInTx,
} from './thread-read-position.js';

export interface ThreadFeedPreview {
  seq: number;
  createdAt: string;
  sender: { account: string; domain: string } | null;
  status: 'LIVE' | 'USER_RETRACTION' | 'MODERATION_REMOVAL';
  text?: string;
}

export interface ThreadFeedState {
  threadId: number;
  threadFeedId: number;
  messageEndSeq: number;
  tombstoneEndSeq: number;
  lastReadSeq: number;
  unreadCount: number;
  lastMentionSeq: number | null;
  previews?: ThreadFeedPreview[];
}

/** Unified compacted thread snapshots and recoverable read mutations. */
@Injectable()
export class ThreadFeedService implements OnModuleInit, OnModuleDestroy {
  @Inject(ThreadPreviewService)
  private readonly previews!: ThreadPreviewService;
  private unregister: Array<() => void> = [];
  constructor(
    private readonly database: DatabaseService,
    private readonly dispatcher: DurableTaskDispatcherService,
  ) {}

  onModuleInit(): void {
    this.unregister.push(
      this.dispatcher.register({
        taskType: DurableTaskType.COMMIT_THREAD_READ_POSITION,
        execute: (task) => this.executeTask(task),
      }),
    );
  }
  onModuleDestroy(): void {
    for (const unregister of this.unregister) unregister();
  }

  async readEndId(accountId: number): Promise<number> {
    const result = await this.database.db.execute<{ head: number }>(sql`
      SELECT "threadFeedEndId" AS head FROM "Account" WHERE id = ${accountId}`);
    if (!result.rows[0]) throw new Error('Thread feed account not found');
    return result.rows[0].head;
  }

  async queryThreadFeedDelta(accountId: number, request: ThreadFeedDeltaDto) {
    const previewCount = request.previewCount ?? 0;
    if (
      !Number.isSafeInteger(previewCount) ||
      previewCount < 0 ||
      (previewCount > 0 && previewCount > this.previews.limit)
    )
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'previewCount exceeds the configured preview limit',
      );
    return this.database.db.transaction(
      async (tx) => {
        const result = await tx.execute<{ threadFeedEndId: number }>(sql`
        SELECT "threadFeedEndId" FROM "Account" WHERE id = ${accountId}`);
        const head = result.rows[0]?.threadFeedEndId;
        if (head === undefined)
          throw new BusinessException(
            BusinessCode.NOT_FOUND,
            'account not found',
          );
        const through = request.through ?? head;
        if (request.after > through || through > head) {
          throw new BusinessException(
            BusinessCode.THREAD_FEED_CURSOR_INVALID,
            'invalid attention feed range',
          );
        }
        const take = request.take ?? 100;
        const resultRows = await tx.execute<
          ThreadFeedState & Record<string, unknown>
        >(sql`
        SELECT "threadId", "threadFeedId", "messageEndSeq", "tombstoneEndSeq", "lastReadSeq", "unreadCount", "lastMentionSeq"
        FROM "AccountThreadState" WHERE "accountId" = ${accountId}
          AND "threadFeedId" > ${request.after} AND "threadFeedId" <= ${through}
        ORDER BY "threadFeedId" LIMIT ${take + 1}`);
        const hasMore = resultRows.rows.length > take;
        const items = resultRows.rows.slice(0, take);
        if (previewCount > 0) {
          for (const item of items) {
            item.previews = (
              await this.previews.readInTx(
                tx,
                accountId,
                item.threadId,
                previewCount,
              )
            ).map(
              (preview): ThreadFeedPreview => ({
                seq: preview.seq,
                createdAt: new Date(preview.createdAt).toISOString(),
                sender:
                  preview.creatorAccount !== null &&
                  preview.creatorDomain !== null
                    ? {
                        account: preview.creatorAccount,
                        domain: preview.creatorDomain,
                      }
                    : null,
                status: preview.isDeleted ? preview.deletionType! : 'LIVE',
                ...(!preview.isDeleted
                  ? {
                      text: deriveMessagePreview(
                        preview.contentType!,
                        preview.content!,
                      ),
                    }
                  : {}),
              }),
            );
          }
        }
        return {
          threadFeedEndId: head,
          through,
          scannedThrough: hasMore
            ? items[items.length - 1].threadFeedId
            : through,
          hasMore,
          items,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async enqueueReadPosition(accountId: number, request: MarkReadDto) {
    return this.database.db.transaction((tx) =>
      enqueueReadPositionInTx(tx, accountId, request),
    );
  }

  private async lockThread(tx: DatabaseTransaction, threadId: number) {
    await tx.execute(
      sql`SELECT 1 FROM "MessageThread" WHERE id = ${threadId} FOR NO KEY UPDATE`,
    );
  }

  /** Caller holds the content lock. Reuse the common read/count/mention writer. */
  async applyReadPositionInTx(
    tx: DatabaseTransaction,
    accountId: number,
    request: MarkReadDto,
  ): Promise<number> {
    return applyReadPositionInTx(tx, accountId, request);
  }

  async executeTask(task: DurableTask): Promise<void> {
    const threadId = task.payload.threadId;
    if (
      task.taskType !== DurableTaskType.COMMIT_THREAD_READ_POSITION ||
      task.scopeType !== 'ACCOUNT_THREAD' ||
      !task.actorUserId ||
      !Number.isInteger(threadId) ||
      (threadId as number) <= 0
    ) {
      throw new Error('invalid attention task scope');
    }
    const execute = async (tx: DatabaseTransaction) => {
      await this.lockThread(tx, threadId as number);
      const current = await tx.execute<{ status: string }>(
        sql`SELECT status FROM "DurableTask" WHERE id = ${task.id} FOR NO KEY UPDATE`,
      );
      if (current.rows[0]?.status === 'SUCCEEDED') return;
      if (current.rows[0]?.status !== 'PROCESSING')
        throw new Error('attention task is not processing');
      const lastReadSeq = await this.applyReadPositionInTx(
        tx,
        task.actorUserId!,
        task.payload as unknown as MarkReadDto,
      );
      // Prevent recovered force-read tasks from replaying after later reads.
      await tx.execute(sql`UPDATE "DurableTask" SET status = 'SUCCEEDED', "completedAt" = CURRENT_TIMESTAMP
        WHERE id = ${task.id} AND status = 'PROCESSING'`);
      return lastReadSeq;
    };
    await this.database.db.transaction(execute);
  }
}
