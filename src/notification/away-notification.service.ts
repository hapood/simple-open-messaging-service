import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { account, clientStateFeed } from '../database/schema.js';
import { NotificationQueryService } from './notification-query.service.js';
import type { NotificationDescriptor } from './notification-descriptor.js';

/**
 * Away/system-notification domain boundary.
 *
 * Callers provide the ClientStateFeed cursor captured before the app became unavailable; the service returns
 * presentation-ready descriptors. Thread-list hydration and local message caching do not belong here.
 */
@Injectable()
export class AwayNotificationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly readModel: NotificationQueryService,
  ) {}

  query(
    userId: number,
    opts: {
      after?: number;
      previewMode?: 'message' | 'private';
      threadHwms?: Record<number, number>;
      acceptLanguage?: string | null;
    },
  ): Promise<{
    notifications: NotificationDescriptor[];
    stateFeedEndId: number;
  }> {
    return (async () => {
      const target = await this.database.db.query.account.findFirst({
        where: eq(account.id, userId),
        columns: { stateFeedAllocatedThrough: true },
      });
      const end = target?.stateFeedAllocatedThrough ?? 0;
      const requestedAfter = opts.after ?? 0;
      const after =
        requestedAfter >= 0 && requestedAfter <= end ? requestedAfter : 0;
      const rows = await this.database.db
        .select({ body: clientStateFeed.body })
        .from(clientStateFeed)
        .where(
          and(
            eq(clientStateFeed.userId, userId),
            eq(clientStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
            gt(clientStateFeed.feedId, after),
          ),
        )
        .orderBy(asc(clientStateFeed.feedId));
      if (rows.length === 0) return { notifications: [], stateFeedEndId: end };
      const threadIds = rows
        .map((row) => (row.body as { threadId?: unknown }).threadId)
        .filter((threadId): threadId is number =>
          Number.isSafeInteger(threadId),
        );
      const result = await this.readModel.buildFeedNotifyResponse(
        userId,
        threadIds,
        opts,
      );
      return { ...result, stateFeedEndId: end };
    })();
  }
}
