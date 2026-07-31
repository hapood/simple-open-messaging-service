import { Injectable } from '@nestjs/common';
import { NotificationQueryService, type MissedCursor } from './notification-query.service.js';
import type { NotificationDescriptor } from './notification-descriptor.js';

/**
 * Away/system-notification domain boundary.
 *
 * Callers provide the last message accounted for before the app became unavailable; the service returns
 * presentation-ready descriptors. Thread-list hydration and local message caching do not belong here.
 */
@Injectable()
export class AwayNotificationService {
  constructor(private readonly readModel: NotificationQueryService) {}

  query(
    userId: number,
    opts: {
      since?: MissedCursor | null;
      grouping?: 'all' | 'thread';
      threadHwms?: Record<number, number>;
      acceptLanguage?: string | null;
    },
  ): Promise<{ notifications: NotificationDescriptor[] }> {
    return this.readModel.buildNotifyResponse(userId, opts);
  }
}
