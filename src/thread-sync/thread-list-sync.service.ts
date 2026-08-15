import { Injectable } from '@nestjs/common';
import {
  NotificationQueryService,
  type MissedCursor,
  type MissedThreadItem,
} from '../notification/notification-query.service.js';

/**
 * Thread-list synchronization boundary.
 *
 * This service deliberately exposes only the `(from, to]` catch-up operation. It keeps conversation
 * hydration out of the system-notification API even while the shared read-model implementation is being
 * extracted from the legacy NotificationQueryService.
 */
@Injectable()
export class ThreadListSyncService {
  constructor(private readonly readModel: NotificationQueryService) {}

  catchUp(
    userId: number,
    opts: { from?: MissedCursor | null; to: MissedCursor; take: number },
  ): Promise<{
    items: MissedThreadItem[];
    hasMore: boolean;
    nextCursor: MissedCursor | null;
  }> {
    return this.readModel.buildSummary(userId, opts);
  }
}
