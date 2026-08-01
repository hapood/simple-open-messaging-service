import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { apiPrefix } from './constants';
import type { StandardResponse } from './model';
import type { MissedCursor, NotificationDescriptor } from './notification-descriptor.model';

/** Page size for the threadlist body walk (the backend caps `take` at 200). */
const SUMMARY_TAKE = 200;

/** One thread's row in POST /notifications/missed-summary. Mirrors the backend MissedThreadItem. The
 *  threadlist reads `latestMessage` for its own preview + the authoritative read state; the
 *  other fields are carried for parity but unused here
 *  (avatars come from the conversation snapshot). */
export interface MissedThreadItem {
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
    creator: number;
    createdAt: number;
    mediaStatus: 'ready' | 'failed';
    sv: number;
  } | null;
}

/** The missed-summary pull result — the per-thread items + the pagination cursor (the walk advances `from`
 *  toward `to`). */
export interface MissedSummaryResult {
  items: MissedThreadItem[];
  hasMore: boolean;
  nextCursor: MissedCursor | null;
}

/** An empty result (errors / concurrent no-op) — the cursor is not advanced, so the next pull re-covers. */
const EMPTY: MissedSummaryResult = { items: [], hasMore: false, nextCursor: null };

/**
 * Compatibility facade over the two separated domain endpoints, each with its OWN single-flight guard:
 * starve each other:
 *  - {@link fetchMissedSummary} — POST /thread-sync/catch-up. Used by ThreadRepository to walk the `(from,
 *    to]` range and update thread-list state. It never writes the chatbox message store.
 *  - {@link fetchAwayNotifications} — POST /notification-feed/query (away notification descriptors). Used by
 *    UnreadAttentionService: per-sender aggregation since the HWM → the server-authored descriptors.
 *
 * Why two guards: a NEW_MESSAGE arriving while unfocused fires BOTH a threadlist body walk (from/to) and an
 * away-summary pull (since). They are DIFFERENT queries, so they cannot share a result — separate guards let
 * both fire (two HTTP calls when they genuinely race; each collapses its OWN bursts).
 *
 * STATELESS beyond the guards: the caller owns the cursors + decides when to pull.
 *
 * The snapshot owns unread state and thread-list previews; chatbox messages have a separate data path.
 */
@Injectable({ providedIn: 'root' })
export class MissedSyncService {
  private readonly http = inject(HttpClient);

  /** Single-flight for the threadlist body-walk path. */
  private summaryInFlight = false;
  /** Single-flight for the away-summary path — independent so it never starves on the summary path. */
  private awayInFlight = false;

  /**
   * Threadlist body walk: fetch ONE page of the `(from, to]` range, cache the bodies, return the result.
   * `from` = the high-water mark (exclusive lower; null on first boot); `to` = the newest SSE signal (pinned
   * inclusive upper). The caller loops pages (advancing `from = nextCursor`) until `!hasMore`, then sets
   * HWM = `to`. Concurrent calls on THIS path collapse (single-flight); the away path has its own guard.
   */
  async fetchMissedSummary(from: MissedCursor | null, to: MissedCursor): Promise<MissedSummaryResult> {
    if (this.summaryInFlight) return EMPTY;
    this.summaryInFlight = true;
    try {
      const res = await firstValueFrom(
        this.http.post<StandardResponse<MissedSummaryResult>>(
          `${apiPrefix()}/thread-sync/catch-up`,
          { ...(from ? { from } : {}), to, take: SUMMARY_TAKE },
          { headers: { Accept: 'application/json', 'Accept-Language': navigator.language || 'en' } },
        ),
      ).catch(() => null);
      if (!res || res.code !== 0 || !res.data) return EMPTY;
      return res.data;
    } finally {
      this.summaryInFlight = false;
    }
  }

  /**
   * Away-notification summary: the server-authored descriptors for the messages newer than `since` (the HWM).
   * Does NOT cache bodies (the threadlist walk owns pre-warm) — only the away-renderer needs the descriptors.
   * Single-flight on its OWN guard, independent of {@link fetchMissedSummary}, so a threadlist walk pulling at
   * the same instant cannot starve the away-notification.
   */
  async fetchAwayNotifications(
    since: MissedCursor | null,
    previewMode: 'message' | 'private' = 'message',
    threadHwms?: Record<number, number>,
  ): Promise<NotificationDescriptor[]> {
    if (this.awayInFlight) return [];
    this.awayInFlight = true;
    try {
      const res = await firstValueFrom(
        this.http.post<StandardResponse<{ notifications: NotificationDescriptor[] }>>(
          `${apiPrefix()}/notification-feed/query`,
          // threadHwms: the client's per-thread dismiss cursors (Android, in-memory). Web omits it (in-page
          // Notifications have no per-card dismiss — only clear-all-on-focus), so the server counts every
          // thread since `since` (cumulative since foreground). Declared on MissedDto.
          { ...(since ? { since } : {}), previewMode, ...(threadHwms ? { threadHwms } : {}) },
          { headers: { Accept: 'application/json', 'Accept-Language': navigator.language || 'en' } },
        ),
      ).catch(() => null);
      if (!res || res.code !== 0 || !res.data) return [];
      return res.data.notifications;
    } finally {
      this.awayInFlight = false;
    }
  }
}
