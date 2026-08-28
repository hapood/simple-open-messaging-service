import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, lte } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  clientMessageFeed,
  clientMessageFeedTarget,
  clientMessageTombstoneFeed,
} from '../database/schema.js';
import {
  NotificationQueryService,
  type ThreadCatchUpItem,
} from '../notification/notification-query.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

/**
 * Thread-list synchronization boundary.
 *
 * Message and tombstone coordinates are independent per-user integers. Each paginated read may pin a
 * `through` bound so it converges while new writes continue.
 */
@Injectable()
export class ThreadListSyncService {
  constructor(
    private readonly database: DatabaseService,
    private readonly readModel: NotificationQueryService,
  ) {}

  async rejectMissingAfter(
    userId: number,
    kind: 'message' | 'tombstone',
  ): Promise<never> {
    const end = await this.readEndId(userId, kind);
    throw new BusinessException(
      BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
      `after is required; initialize the client ${kind} feed cursor`,
      HttpStatus.OK,
      { resumeAfter: 0, resumeBefore: end + 1 },
    );
  }

  private async readEndId(
    userId: number,
    kind: 'message' | 'tombstone',
  ): Promise<number> {
    await this.database.db
      .insert(clientMessageFeedTarget)
      .values({ userId })
      .onConflictDoNothing({ target: clientMessageFeedTarget.userId });
    const target =
      await this.database.db.query.clientMessageFeedTarget.findFirst({
        where: eq(clientMessageFeedTarget.userId, userId),
        columns: {
          messageAllocatedThrough: true,
          tombstoneAllocatedThrough: true,
        },
      });
    return kind === 'message'
      ? (target?.messageAllocatedThrough ?? 0)
      : (target?.tombstoneAllocatedThrough ?? 0);
  }

  async catchUp(
    userId: number,
    opts: { after: number; through?: number; take: number },
  ): Promise<{
    items: ThreadCatchUpItem[];
    scannedThrough: number;
    messageFeedEndId: number;
    hasMore: boolean;
  }> {
    return this.database.db.transaction(async (tx) => {
      await tx
        .insert(clientMessageFeedTarget)
        .values({ userId })
        .onConflictDoNothing({ target: clientMessageFeedTarget.userId });
      const [target] = await tx
        .select({ end: clientMessageFeedTarget.messageAllocatedThrough })
        .from(clientMessageFeedTarget)
        .where(eq(clientMessageFeedTarget.userId, userId))
        .limit(1);
      const end = target?.end ?? 0;
      if (opts.after < 0 || opts.after > end)
        throw new BusinessException(
          BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
          'message feed cursor is outside the available coordinate space',
          HttpStatus.OK,
          { resumeAfter: 0, resumeBefore: end + 1 },
        );
      const requestEnd =
        opts.through === undefined || opts.through > end ? end : opts.through;
      if (requestEnd < opts.after)
        throw new BusinessException(
          BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
          'message feed through precedes after',
          HttpStatus.OK,
          { resumeAfter: 0, resumeBefore: end + 1 },
        );
      const rows = await tx
        .select({
          threadId: clientMessageFeed.threadId,
          feedId: clientMessageFeed.feedId,
          messageEndSeq: clientMessageFeed.messageEndSeq,
        })
        .from(clientMessageFeed)
        .where(
          and(
            eq(clientMessageFeed.userId, userId),
            gt(clientMessageFeed.feedId, opts.after),
            lte(clientMessageFeed.feedId, requestEnd),
          ),
        )
        .orderBy(asc(clientMessageFeed.feedId))
        .limit(opts.take + 1);
      const selected = rows.slice(0, opts.take);
      const scannedThrough =
        rows.length > opts.take ? selected.at(-1)!.feedId : requestEnd;
      const items = await this.readModel.hydrateCatchUpThreads(
        userId,
        selected.map((row) => ({
          threadId: row.threadId,
          messageEndSeq: row.messageEndSeq,
        })),
      );
      return {
        items,
        scannedThrough,
        messageFeedEndId: end,
        hasMore: scannedThrough < requestEnd,
      };
    });
  }

  async catchUpTombstones(
    userId: number,
    opts: { after: number; through?: number; take: number },
  ): Promise<{
    items: Array<{
      feedId: number;
      threadId: number;
      tombstoneEndSeq: number;
    }>;
    scannedThrough: number;
    tombstoneFeedEndId: number;
    hasMore: boolean;
  }> {
    return this.database.db.transaction(async (tx) => {
      await tx
        .insert(clientMessageFeedTarget)
        .values({ userId })
        .onConflictDoNothing({ target: clientMessageFeedTarget.userId });
      const [target] = await tx
        .select({ end: clientMessageFeedTarget.tombstoneAllocatedThrough })
        .from(clientMessageFeedTarget)
        .where(eq(clientMessageFeedTarget.userId, userId))
        .limit(1);
      const end = target?.end ?? 0;
      this.assertCursor(opts.after, opts.through, end, 'tombstone');
      const requestEnd = Math.min(opts.through ?? end, end);
      const rows = await tx
        .select({
          feedId: clientMessageTombstoneFeed.feedId,
          threadId: clientMessageTombstoneFeed.threadId,
          tombstoneEndSeq: clientMessageTombstoneFeed.tombstoneEndSeq,
        })
        .from(clientMessageTombstoneFeed)
        .where(
          and(
            eq(clientMessageTombstoneFeed.userId, userId),
            gt(clientMessageTombstoneFeed.feedId, opts.after),
            lte(clientMessageTombstoneFeed.feedId, requestEnd),
          ),
        )
        .orderBy(asc(clientMessageTombstoneFeed.feedId))
        .limit(opts.take + 1);
      const selected = rows.slice(0, opts.take);
      const scannedThrough =
        rows.length > opts.take ? selected.at(-1)!.feedId : requestEnd;
      return {
        items: selected,
        scannedThrough,
        tombstoneFeedEndId: end,
        hasMore: scannedThrough < requestEnd,
      };
    });
  }

  private assertCursor(
    after: number,
    through: number | undefined,
    end: number,
    kind: 'message' | 'tombstone',
  ): void {
    if (
      after >= 0 &&
      after <= end &&
      (through === undefined || through >= after)
    )
      return;
    throw new BusinessException(
      BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
      `${kind} feed cursor is outside the available coordinate space`,
      HttpStatus.OK,
      { resumeAfter: 0, resumeBefore: end + 1 },
    );
  }
}
