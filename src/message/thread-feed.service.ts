import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { ThreadFeedDeltaDto } from '../dto/message.dto.js';
import { ThreadPreviewService } from './thread-preview.service.js';
import { deriveMessagePreview } from '../../shared/message-preview.js';

interface ThreadFeedPreview {
  seq: number;
  createdAt: string;
  sender: { account: string; domain: string } | null;
  status: 'LIVE' | 'USER_RETRACTION' | 'MODERATION_REMOVAL';
  text?: string;
}

interface ThreadFeedState {
  threadId: number;
  threadFeedId: number;
  messageEndSeq: number;
  tombstoneEndSeq: number;
  groupMetaFeedEndId: number | null;
  threadProfileRev: number;
  lastReadSeq: number;
  unreadCount: number;
  lastMentionSeq: number | null;
  previews?: ThreadFeedPreview[];
}

/** Unified compacted thread snapshots. */
@Injectable()
export class ThreadFeedService {
  @Inject(ThreadPreviewService)
  private readonly previews!: ThreadPreviewService;
  constructor(private readonly database: DatabaseService) {}

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
        SELECT "threadId", "threadFeedId", "messageEndSeq", "tombstoneEndSeq",
               "groupMetaFeedEndId",
               "threadProfileRev", "lastReadSeq", "unreadCount", "lastMentionSeq"
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
}
