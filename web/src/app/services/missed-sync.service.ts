import { Injectable, inject, effect, untracked, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription, firstValueFrom } from 'rxjs';
import { WebdbService } from './webdb.service';
import { WebsocketService } from './websocket.service';
import { MessageRepository } from './message-repository.service';
import { UserService } from './user.service';
import { apiPrefix } from './constants';
import type { Message, StandardResponse } from './model';

/** Page size for the missed catch-up (the backend caps `take` at 200; 100 balances round-trips vs load). */
const MISSED_PAGE_SIZE = 100;

/** One page of `POST /notifications/missed` (the paginated, non-summary form). `messages` are time-ascending
 *  full Message rows (id-stripped); `nextCursor` is the opaque continuation token echoed on the next page. */
interface MissedPage {
  messages: Message[];
  hasMore: boolean;
  nextCursor?: string;
}

/**
 * App-open + reconnect catch-up for message bodies the SSE stream does not replay.
 *
 * The realtime stream is live-only: while the app was closed (or suspended), messages landed on the server
 * but were never pushed. The threadlist snapshot (ThreadRepository.boot) refreshes preview/unread/membership,
 * but it does NOT hydrate the per-thread message store — so opening a thread that grew offline would show a
 * stale tail until the chat-box's init probe refetched. This service closes that gap: it pages the cross-
 * thread `POST /notifications/missed` endpoint bound by a persisted high-water-mark (the newest cached
 * message's `createdAt`, owned by {@link MessageRepository}) and applies every page through the SAME apply
 * path a live `NEW_MESSAGE` takes ({@link MessageRepository.applyMissed}).
 *
 * Crucially the apply is direct on {@link MessageRepository} — it does NOT re-emit on `eventSubject`.
 * `UnreadAttentionService` subscribes to `NEW_MESSAGE` there and would post a desktop notification (and bump
 * the title badge) for every caught-up message on every app-open; the snapshot already owns unread/preview,
 * so the catch-up must only hydrate bodies, never re-fire the "new message" attention path.
 *
 * **First boot** (no HWM yet): the endpoint's INIT mode returns the newest message per thread (a bounded
 * seed, one shot — not a full history dump); older history stays lazy-loaded per thread on scroll. Every
 * later boot pages catch-up `since:HWM` → `{cursor}` until `!hasMore`. Re-applied pages are idempotent
 * (`[threadId, seq]` key), so a crashed catch-up or a racing live SSE frame are both safe to re-apply.
 */
@Injectable({ providedIn: 'root' })
export class MissedSyncService implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly webdb = inject(WebdbService);
  private readonly ws = inject(WebsocketService);
  private readonly messageRepo = inject(MessageRepository);
  private readonly userService = inject(UserService);

  /** Single-flight: a boot/reconnect burst collapses into one catch-up; a concurrent caller is a no-op. */
  private inFlight = false;
  private readonly sub: Subscription;

  constructor() {
    // Reconnect → catch up (the SSE stream resumed, but the offline gap is not replayed).
    this.sub = this.ws.reconnect$.subscribe(() => {
      void this.catchUp();
    });
    // App-open: run once the per-user DB is open post-login. Tracks `ready()` only; the sessionProfile read
    // is untracked so a mid-session signal change doesn't re-fire this (a logout toggles ready false→no-op;
    // a re-login toggles it false→true→catch-up for the new user).
    effect(() => {
      if (this.webdb.ready() && untracked(() => this.userService.sessionProfile()?.id) != null) {
        void this.catchUp();
      }
    });
  }

  /**
   * Page the missed-since-HWM messages and cache them via the shared apply path. Idempotent + single-flight
   * + session-end guarded (bails if the user logs out mid-page). Errors degrade silently: the next reconnect
   * retries, and any partial progress is durable (cached messages + advanced HWM survive in IDB).
   */
  async catchUp(): Promise<void> {
    if (this.inFlight) return;
    if (!this.webdb.ready()) return; // no DB → nothing to cache into (the effect gate usually covers this)
    this.inFlight = true;
    try {
      // First page bound: the HWM (null → INIT newest-per-thread seed). Every later page uses the opaque cursor.
      const hwm = await this.messageRepo.getHwm();
      let bound: { since?: number; cursor?: string } = hwm == null ? {} : { since: hwm };
      for (;;) {
        // Bail if the session ended mid-catch-up (logout / account switch).
        if (untracked(() => this.userService.sessionProfile()?.id) == null) return;
        const res = await firstValueFrom(
          this.http.post<StandardResponse<MissedPage>>(`${apiPrefix()}/notifications/missed`, {
            ...bound,
            take: MISSED_PAGE_SIZE,
          }),
        ).catch(() => null);
        if (!res || res.code !== 0 || !res.data) return;
        await this.messageRepo.applyMissed(res.data.messages ?? []);
        if (!res.data.hasMore || !res.data.nextCursor) return;
        bound = { cursor: res.data.nextCursor }; // cursor takes precedence; `since` is dropped hereafter
      }
    } finally {
      this.inFlight = false;
    }
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }
}
