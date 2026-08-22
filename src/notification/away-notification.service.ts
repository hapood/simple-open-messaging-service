import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  clientMessageFeed,
  clientMessageFeedTarget,
} from '../database/schema.js';
import { NotificationQueryService } from './notification-query.service.js';
import type { NotificationDescriptor } from './notification-descriptor.js';

/**
 * Away/system-notification domain boundary.
 *
 * Callers provide the last message accounted for before the app became unavailable; the service returns
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
    messageFeedEndId: number;
  }> {
    return (async () => {
      await this.database.db
        .insert(clientMessageFeedTarget)
        .values({ userId })
        .onConflictDoNothing({ target: clientMessageFeedTarget.userId });
      const target =
        await this.database.db.query.clientMessageFeedTarget.findFirst({
          where: eq(clientMessageFeedTarget.userId, userId),
          columns: { messageAllocatedThrough: true },
        });
      const end = target?.messageAllocatedThrough ?? 0;
      const requestedAfter = opts.after ?? 0;
      const after =
        requestedAfter >= 0 && requestedAfter <= end ? requestedAfter : 0;
      const rows = await this.database.db
        .select({ threadId: clientMessageFeed.threadId })
        .from(clientMessageFeed)
        .where(
          and(
            eq(clientMessageFeed.userId, userId),
            gt(clientMessageFeed.feedId, after),
          ),
        )
        .orderBy(asc(clientMessageFeed.feedId));
      const result = await this.readModel.buildFeedNotifyResponse(
        userId,
        rows.map((row) => row.threadId),
        opts,
      );
      return { ...result, messageFeedEndId: end };
    })();
  }
}
