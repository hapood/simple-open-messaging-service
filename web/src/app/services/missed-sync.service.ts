import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MessageRepository } from './message-repository.service';
import { apiPrefix } from './constants';
import type { Message, StandardResponse } from './model';
import type { MissedCursor, NotificationDescriptor } from './notification-descriptor.model';

/** Page size for the threadlist body walk (the backend caps `take` at 200). */
const SUMMARY_TAKE = 200;

/** One thread's row in POST /notifications/missed-summary. Mirrors the backend MissedThreadItem. The
 *  threadlist reads only `latestMessage` (the body for preview pre-warm); the other fields are carried for
 *  parity but unused here (avatars come from the conversation snapshot). */
export interface MissedThreadItem {
  threadId: number;
  type: 'P2P' | 'GROUP';
  displayName: string;
  unreadCount: number;
  muted: boolean;
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
 * The two SEPARATED missed endpoints, each with its OWN single-flight guard so the two consumers never
 * starve each other:
 *  - {@link fetchMissedSummary} — POST /notifications/missed-summary (the threadlist body pre-warm). Used by
 *    ThreadRepository: walks the `(from, to]` double-boundary range of per-thread latest bodies, caching each
 *    into the local store.
 *  - {@link fetchAwayNotifications} — POST /notifications/missed (the away-notification summary). Used by
 *    UnreadAttentionService: per-sender aggregation since the HWM → the server-authored descriptors.
 *
 * Why two guards: a NEW_MESSAGE arriving while unfocused fires BOTH a threadlist body walk (from/to) and an
 * away-summary pull (since). They are DIFFERENT queries, so they cannot share a result — separate guards let
 * both fire (two HTTP calls when they genuinely race; each collapses its OWN bursts).
 *
 * STATELESS beyond the guards: the caller owns the cursors + decides when to pull.
 *
 * The items-path apply is direct on MessageRepository — it does NOT re-emit on eventSubject, so
 * UnreadAttentionService (subscribed to NEW_MESSAGE there) is NOT triggered; the snapshot owns unread.
 */
@Injectable({ providedIn: 'root' })
export class MissedSyncService {
  private readonly http = inject(HttpClient);
  private readonly messageRepo = inject(MessageRepository);

  /** Single-flight for the threadlist body-walk path. */
  private summaryInFlight = false;
  /** Single-flight for the away-summary path — independent so it never starves on the summary path. */
  private awayInFlight = false;

  /** Cache each thread's latest-message body (pre-warm so opening a thread is instant). The summary row is
   *  the full message minus id; fill the storage-only defaults the IDB record carries. */
  private async cacheBodies(items: MissedThreadItem[]): Promise<void> {
    const bodies = items
      .map((i) => i.latestMessage)
      .filter((m): m is NonNullable<typeof m> => m != null)
      .map(
        (m): Message =>
          ({
            threadId: m.threadId,
            seq: m.seq,
            contentType: m.contentType as Message['contentType'],
            content: m.content,
            creator: m.creator,
            createdAt: m.createdAt,
            updatedAt: m.createdAt,
            isDeleted: false,
            mediaStatus: m.mediaStatus,
            sv: m.sv,
          }) as unknown as Message,
      );
    if (bodies.length > 0) await this.messageRepo.applyMissed(bodies);
  }

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
          `${apiPrefix()}/notifications/missed-summary`,
          { ...(from ? { from } : {}), to, take: SUMMARY_TAKE },
          { headers: { Accept: 'application/json', 'Accept-Language': navigator.language || 'en' } },
        ),
      ).catch(() => null);
      if (!res || res.code !== 0 || !res.data) return EMPTY;
      if (res.data.items.length > 0) await this.cacheBodies(res.data.items);
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
  async fetchAwayNotifications(since: MissedCursor | null): Promise<NotificationDescriptor[]> {
    if (this.awayInFlight) return [];
    this.awayInFlight = true;
    try {
      const res = await firstValueFrom(
        this.http.post<StandardResponse<{ notifications: NotificationDescriptor[] }>>(
          `${apiPrefix()}/notifications/missed`,
          { ...(since ? { since } : {}) },
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
