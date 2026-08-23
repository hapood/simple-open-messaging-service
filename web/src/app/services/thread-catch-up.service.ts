import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { apiPrefix } from './constants';
import type { StandardResponse } from './model';

/** Page size for the threadlist body walk (the backend caps `take` at 200). */
const SUMMARY_TAKE = 200;
const CLIENT_FEED_CURSOR_UNAVAILABLE = 30006;

/** One thread's row in GET /thread-sync/catch-up. Mirrors the backend ThreadCatchUpItem. The
 *  threadlist reads `latestMessage` for its own preview + the authoritative read state; the
 *  other fields are carried for parity but unused here
 *  (avatars come from the conversation snapshot). */
export interface ThreadCatchUpItem {
  threadId: number;
  type: 'P2P' | 'GROUP';
  displayName: string;
  unreadCount: number;
  /** Optional for compatibility with an older server during rolling upgrades. */
  mentionUnread?: Array<'all' | 'me'>;
  muted: boolean;
  /** The caller's server-confirmed per-thread read watermark (null = never read). */
  lastReadSeq: number | null;
  senderAvatarUrl: string;
  senderUserId: number;
  latestMessage: {
    threadId: number;
    seq: number;
    contentType: string;
    content: string;
    creator: number | null;
    createdAt: number;
    mediaStatus: 'ready' | 'failed';
    sv: number;
  } | null;
}

/** One message-feed page with its durable integer cursor and current feed end. */
export interface ThreadCatchUpResult {
  items: ThreadCatchUpItem[];
  hasMore: boolean;
  scannedThrough: number;
  messageFeedEndId: number;
}

export interface TombstoneCatchUpResult {
  items: Array<{
    feedId: number;
    threadId: number;
    tombstoneEndSeq: string;
  }>;
  hasMore: boolean;
  scannedThrough: number;
  tombstoneFeedEndId: number;
}

/**
 * HTTP client for the two independent per-user compacted feeds. Callers own and durably commit the integer
 * cursors; the service owns only one single-flight guard per feed.
 */
@Injectable({ providedIn: 'root' })
export class ThreadCatchUpService {
  private readonly http = inject(HttpClient);

  /** Single-flight for the threadlist body-walk path. */
  private summaryInFlight = false;
  private tombstoneInFlight = false;

  /**
   * Fetch one compacted message-feed page. The caller pins `through` from the first response and advances
   * `after = scannedThrough` until `hasMore` is false. Concurrent calls collapse into one request.
   */
  async catchUp(
    after: number,
    through?: number,
  ): Promise<ThreadCatchUpResult | null> {
    if (this.summaryInFlight) return null;
    this.summaryInFlight = true;
    try {
      const res = await firstValueFrom(
        this.http.get<StandardResponse<ThreadCatchUpResult>>(
          `${apiPrefix()}/thread-sync/catch-up?${this.feedQuery(after, through)}`,
          {
            headers: {
              Accept: 'application/json',
              'Accept-Language': navigator.language || 'en',
            },
          },
        ),
      ).catch(() => null);
      if (!res) return null;
      if (res.code === CLIENT_FEED_CURSOR_UNAVAILABLE) {
        const reset = res.data as unknown as {
          resumeAfter?: unknown;
          resumeBefore?: unknown;
        };
        if (
          Number.isSafeInteger(reset?.resumeAfter) &&
          Number.isSafeInteger(reset?.resumeBefore) &&
          (reset.resumeAfter as number) >= 0 &&
          (reset.resumeBefore as number) > (reset.resumeAfter as number)
        ) {
          const after = reset.resumeAfter as number;
          const end = (reset.resumeBefore as number) - 1;
          return {
            items: [],
            scannedThrough: after,
            messageFeedEndId: end,
            hasMore: after < end,
          };
        }
      }
      if (res.code !== 0 || !res.data) return null;
      return res.data;
    } finally {
      this.summaryInFlight = false;
    }
  }

  async catchUpTombstones(
    after: number,
    through?: number,
  ): Promise<TombstoneCatchUpResult | null> {
    if (this.tombstoneInFlight) return null;
    this.tombstoneInFlight = true;
    try {
      const res = await firstValueFrom(
        this.http.get<StandardResponse<TombstoneCatchUpResult>>(
          `${apiPrefix()}/thread-sync/tombstones?${this.feedQuery(after, through)}`,
        ),
      ).catch(() => null);
      if (!res) return null;
      if (res.code === CLIENT_FEED_CURSOR_UNAVAILABLE) {
        const reset = res.data as unknown as {
          resumeAfter?: unknown;
          resumeBefore?: unknown;
        };
        if (
          Number.isSafeInteger(reset?.resumeAfter) &&
          Number.isSafeInteger(reset?.resumeBefore)
        ) {
          const resetAfter = reset.resumeAfter as number;
          const end = (reset.resumeBefore as number) - 1;
          return {
            items: [],
            scannedThrough: resetAfter,
            tombstoneFeedEndId: end,
            hasMore: resetAfter < end,
          };
        }
      }
      return res.code === 0 && res.data ? res.data : null;
    } finally {
      this.tombstoneInFlight = false;
    }
  }

  private feedQuery(after: number, through?: number): string {
    const query = new URLSearchParams({
      after: String(after),
      take: String(SUMMARY_TAKE),
    });
    if (through !== undefined) query.set('through', String(through));
    return query.toString();
  }
}
