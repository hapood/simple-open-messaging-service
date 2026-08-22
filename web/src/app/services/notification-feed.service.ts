import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { apiPrefix } from './constants';
import type { StandardResponse } from './model';
import type { NotificationDescriptor } from './notification-descriptor.model';

export interface NotificationFeedResult {
  notifications: NotificationDescriptor[];
  messageFeedEndId: number;
}

/** HTTP boundary for server-authored away/system notification descriptors. */
@Injectable({ providedIn: 'root' })
export class NotificationFeedService {
  private readonly http = inject(HttpClient);
  private inFlight = false;

  async query(
    after: number,
    previewMode: 'message' | 'private' = 'message',
    threadHwms?: Record<number, number>,
  ): Promise<NotificationFeedResult | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      const res = await firstValueFrom(
        this.http.post<StandardResponse<NotificationFeedResult>>(
          `${apiPrefix()}/notification-feed/query`,
          {
            after,
            previewMode,
            ...(threadHwms ? { threadHwms } : {}),
          },
        ),
      ).catch(() => null);
      return res?.code === 0 && res.data ? res.data : null;
    } finally {
      this.inFlight = false;
    }
  }
}
