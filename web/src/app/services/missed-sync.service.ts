import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MessageRepository } from './message-repository.service';
import { apiPrefix } from './constants';
import type { Message, StandardResponse } from './model';
import type { MissedCursor, NotificationDescriptor } from './notification-descriptor.model';

/** Page size for the missed-summary pull (the backend caps `take` at 200; 50 balances round-trips). */
const MISSED_TAKE = 50;

/** One thread's row in the POST /notifications/missed summary. Mirrors the backend MissedThreadItem. */
export interface MissedThreadItem {
  threadId: number;
  type: 'P2P' | 'GROUP';
  displayName: string;
  unreadCount: number;
  /** Per-user mute flag — the away-notification filters unread+unmuted. */
  muted: boolean;
  /** The sender's avatar URL (P2P peer / GROUP group); '' when none. Unused by the threadlist preview. */
  senderAvatarUrl: string;
  /** The sender's stable id. Unused by the threadlist preview (the icon compositor reads it server-side). */
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

/** The missed-summary pull result — the data view (`items`) + the forward cursor + the notification
 *  descriptors (consumed by the foreground away-renderer). */
export interface MissedSummaryResult {
  items: MissedThreadItem[];
  hasMore: boolean;
  nextCursor: MissedCursor | null;
  notifications: NotificationDescriptor[];
}

/** An empty result (errors / concurrent no-op) — the cursor is not advanced, so the next pull re-covers. */
const EMPTY: MissedSummaryResult = { items: [], hasMore: false, nextCursor: null, notifications: [] };

/**
 * The missed-summary puller. Fetches `POST /notifications/missed { cursor }` and exposes TWO projections
 * over it, each with its OWN single-flight guard so the two consumers never starve each other:
 *  - {@link fetchMissedSummary} — the threadlist catch-up (items + body cache). Used by ThreadRepository.
 *  - {@link fetchAwayNotifications} — the foreground away-snapshot (descriptors only). Used by
 *    UnreadAttentionService.
 *
 * Why two guards: a NEW_MESSAGE arriving while the window is unfocused fires BOTH a threadlist catch-up
 * pull (cursor-based) and an away-snapshot pull (null cursor). They are DIFFERENT queries, so they cannot
 * share a result — but sharing ONE single-flight guard meant the second caller got an empty result and the
 * away-notification could intermittently fail to render. Separate guards let both fire (two HTTP calls when
 * they genuinely race; each collapses its OWN bursts).
 *
 * STATELESS beyond the guards: the caller owns the cursor + decides when to pull (boot / resume / push-wake).
 *
 * The items-path apply is direct on MessageRepository — it does NOT re-emit on eventSubject, so
 * UnreadAttentionService (subscribed to NEW_MESSAGE there) is NOT triggered; the snapshot owns unread.
 */
@Injectable({ providedIn: 'root' })
export class MissedSyncService {
  private readonly http = inject(HttpClient);
  private readonly messageRepo = inject(MessageRepository);

  /** Single-flight for the items (threadlist catch-up) path. */
  private itemsInFlight = false;
  /** Single-flight for the away (descriptor snapshot) path — independent so it never starves on the items path. */
  private awayInFlight = false;

  /** Raw HTTP POST + parse — no guard, no body cache (the shared fetch both projections build on). */
  private async postMissed(cursor: MissedCursor | null): Promise<MissedSummaryResult> {
    const res = await firstValueFrom(
      this.http.post<StandardResponse<MissedSummaryResult>>(
        `${apiPrefix()}/notifications/missed`,
        { ...(cursor ? { cursor } : {}), take: MISSED_TAKE },
        { headers: { Accept: 'application/json', 'Accept-Language': navigator.language || 'en' } },
      ),
    ).catch(() => null);
    if (!res || res.code !== 0 || !res.data) return EMPTY;
    return res.data;
  }

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
   * Threadlist catch-up: fetch one page (cursor forward), cache the bodies, return the full result (items +
   * nextCursor + notifications). `cursor` null → snapshot (newest `take`). Concurrent calls on THIS path
   * collapse (single-flight); the away path has its own guard.
   */
  async fetchMissedSummary(cursor: MissedCursor | null): Promise<MissedSummaryResult> {
    if (this.itemsInFlight) return EMPTY;
    this.itemsInFlight = true;
    try {
      const data = await this.postMissed(cursor);
      if (data.items.length > 0) await this.cacheBodies(data.items);
      return data;
    } finally {
      this.itemsInFlight = false;
    }
  }

  /**
   * Foreground away-snapshot: fetch the descriptors (null cursor → current unread state) for the
   * away-notification / popup. Does NOT cache bodies (the threadlist catch-up owns pre-warm) — only the
   * away-renderer needs the descriptors. Single-flight on its OWN guard, independent of {@link fetchMissedSummary},
   * so a threadlist catch-up pulling at the same instant cannot starve the away-notification.
   */
  async fetchAwayNotifications(): Promise<NotificationDescriptor[]> {
    if (this.awayInFlight) return [];
    this.awayInFlight = true;
    try {
      return (await this.postMissed(null)).notifications;
    } finally {
      this.awayInFlight = false;
    }
  }
}
