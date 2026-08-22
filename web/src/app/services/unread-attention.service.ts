import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { filter } from 'rxjs';
import { ConversationListService } from './conversation-list.service';
import { WebsocketService } from './websocket.service';
import { isAndroidNative, isTauri } from './runtime';
import { NotificationPrefsService } from './notification-prefs.service';
import { NotificationFeedService } from './notification-feed.service';
import { NotificationAdapter } from './notification-adapter';
import { BrowserNotificationAdapter } from './browser-notification.adapter';
import { TauriNotificationAdapter } from './tauri-notification.adapter';
import { NavStateMachineService } from './nav-state.service';
import { SOMS_NOTIF_MSG, type SwNotifMessage } from './sw-notif-protocol';

/**
 * Foreground "you have unread" attention for **PC desktop + browser** — the channels that lack a
 * background push path (mobile Android has FCM/WorkManager; the browser has Web Push for the tab-closed
 * case). When the window/tab loses focus while there are unread messages, this service:
 *
 *  1. Prefixes the document title with the unread count — "(N) SOMS" — while the window is unfocused
 *     (the Slack/Discord/Telegram convention: a static prefix, NOT a blinking toggle). `document.title`
 *     drives BOTH a browser tab's title AND — on Tauri desktop — the OS window title (Tauri syncs it
 *     automatically), so one mechanism covers both surfaces.
 *  2. On each NEW_MESSAGE arriving while unfocused, debounces `/notification-feed/query` from the frozen
 *     foreground cursor and renders the server-authored descriptor(s) via the per-platform
 *     {@link NotificationAdapter}. A burst collapses into one trailing pull (the server composes the body +
 *     the stacked-avatar icon, so there is no local tally/composition). The notification is dismissed the
 *     instant the window regains focus.
 *
 * Stops the moment the window regains focus (the user is now looking at the app). Android returns before
 * installing any focus/SSE listeners: Activity lifecycle is the authoritative foreground signal there, and
 * native FCM/WorkManager/RealtimeService own its away notifications.
 */
@Injectable({ providedIn: 'root' })
export class UnreadAttentionService {
  private readonly convList = inject(ConversationListService);
  private readonly ws = inject(WebsocketService);
  private readonly prefs = inject(NotificationPrefsService);
  private readonly notificationFeed = inject(NotificationFeedService);
  private readonly nav = inject(NavStateMachineService);

  /** The page's original title, captured at construction before any prefix is applied. */
  private readonly baseTitle =
    typeof document !== 'undefined' ? document.title : 'SOMS';
  /** Whether the window/tab currently has focus. Drives the title-prefix + notification gate. */
  private readonly focused = signal(true);

  /** Total unread across ALL conversations — drives the document "(N)" title prefix, shown only while the
   *  window is unfocused (you aren't viewing any thread, so the global total is the right attention signal).
   *  This intentionally does NOT exclude the open thread: while a thread is open its unread is held at 0
   *  (the exit-time read commit refreshes it), so in practice this coincides with the
   *  exclude-open total used by {@link MessageHeaderComponent.otherUnreadCount}. The two are kept as
   *  separate, purpose-fit signals rather than unified — the title serves the unfocused window, the badge
   *  serves the in-conversation back button. */
  private readonly unreadTotal = computed(() =>
    this.convList.items().reduce((sum, it) => sum + (it.unreadCount ?? 0), 0),
  );

  /** Coalesce a burst of NEW_MESSAGE frames into one trailing notification-feed query + render. The server
   *  composes the descriptor, so a single debounced fetch (not a per-message post) is enough. */
  private static readonly DEBOUNCE_MS = 300;
  private awayFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Frozen message-feed cursor from the foreground→away edge. Reusing it makes replacement cards
   * cumulative for the whole away period even though thread catch-up continues in parallel. */
  private awayAfter = 0;

  /** Per-platform notification display adapter (browser / desktop-Tauri / Android), selected once at
   *  construction — this class delegates every render to it and carries no platform branching. */
  private readonly adapter!: NotificationAdapter;

  constructor() {
    if (typeof document === 'undefined') return;
    // Android notification visibility is owned by MainActivity.onResume/onStop + the native background
    // delivery paths. WebView blur/visibility events do not reliably represent Activity foreground state.
    if (isAndroidNative()) return;
    // Select the desktop/browser display adapter ONCE (mirrors WebsocketService's transport selection).
    this.adapter = isTauri()
      ? new TauriNotificationAdapter()
      : new BrowserNotificationAdapter(this.prefs);
    // Track focus. visibilitychange catches tab-switch; blur/focus catches the window losing focus to
    // another app without the tab hiding (the desktop case the user specifically wants covered).
    window.addEventListener('blur', () => this.onFocusChange(false), {
      passive: true,
    });
    window.addEventListener('focus', () => this.onFocusChange(true), {
      passive: true,
    });
    document.addEventListener('visibilitychange', () =>
      this.onFocusChange(document.visibilityState === 'visible'),
    );

    // Control channel FROM the push service worker: a shade-notification action (per-card dismiss, body-tap
    // deep-link) fires in the SW's `notificationclick`, which can't reach the Angular layer directly — the
    // SW postMessages the page (spec-delivered even though ngsw, not sw-push, controls this page). Routed in
    // {@link onSwMessage} to the per-thread HWM store (dismiss) + thread navigation (open).
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e) =>
        this.onSwMessage(e),
      );
    }

    // React to unread/focus changes: apply or clear the "(N)" title prefix.
    effect(() => this.syncTitle(this.unreadTotal(), this.focused()));

    // A NEW_MESSAGE arriving while unfocused → schedule a debounced pull + render. The kernel's pull
    // pipeline still renders the bubble; this is just the "heads-up, look over here" tap.
    this.ws.eventSubject
      .pipe(filter((m) => m.event === 'NEW_MESSAGE'))
      .subscribe(() => {
        if (!this.focused()) this.scheduleRender();
      });
  }

  private onFocusChange(focused: boolean): void {
    if (!focused && this.focused())
      this.awayAfter = this.convList.messageFeedCursor();
    // The effect owns document.title; flipping `focused` re-runs it and restores the base title.
    this.focused.set(focused);
    if (focused) this.dismissActive();
  }

  /** Apply the static "(N)" prefix while there are unreads AND the window is unfocused (the
   *  Slack/Discord/Telegram convention — no blinking); the base title otherwise. Runs inside an
   *  effect so it reacts to unread/focus changes. */
  private syncTitle(unread: number, focused: boolean): void {
    document.title =
      unread > 0 && !focused
        ? `(${this.unreadTotal()}) ${this.baseTitle}`
        : this.baseTitle;
  }

  /** Tear down the away notification when the user returns to the tab: cancel any pending pull (so a
   *  burst's trailing render can't fire AFTER focus returns), dismiss the system notification, and reset
   *  the per-thread dismiss-HWMs (the Android "foreground → all per-thread HWMs
   *  reset" model — a dismissed thread re-fires next away period). */
  private dismissActive(): void {
    if (this.awayFlushTimer !== null) {
      clearTimeout(this.awayFlushTimer);
      this.awayFlushTimer = null;
    }
    void this.adapter.clear();
    this.convList.clearThreadDismiss();
  }

  /** Handle a postMessage from a service worker (the push SW's `notificationclick` dispatches here — the SW
   *  can't reach the Angular `WebdbService`, so it postMessages the page). `soms-notif-dismiss` records the
   *  per-thread HWM so the next away fetch gates that thread past the dismissed seq; `soms-notif-open`
   *  deep-links to the tapped thread. Unknown messages are ignored (forward-compat). */
  private onSwMessage(e: MessageEvent): void {
    const d = (e.data ?? {}) as Partial<SwNotifMessage>;
    if (d.type === SOMS_NOTIF_MSG.DISMISS) {
      if (typeof d.threadId === 'number' && typeof d.seq === 'number') {
        this.convList.recordThreadDismiss({ threadId: d.threadId, seq: d.seq });
      }
      return;
    }
    if (d.type === SOMS_NOTIF_MSG.OPEN) {
      if (typeof d.threadId === 'number') {
        window.focus();
        this.nav.openChat(d.threadId);
      }
    }
  }

  /** Arm a single trailing debounced pull + render. Re-arming within the window pushes the fire out (a
   *  burst collapses to the last message's trailing edge). */
  private scheduleRender(): void {
    if (this.awayFlushTimer !== null) clearTimeout(this.awayFlushTimer);
    this.awayFlushTimer = setTimeout(() => {
      this.awayFlushTimer = null;
      void this.pullAndRender();
    }, UnreadAttentionService.DEBOUNCE_MS);
  }

  /** Pull the current unread snapshot (the away-notification descriptors) and render each via the adapter,
   *  Sends the per-thread dismiss-HWM map (`threadHwms`) so a dismissed thread's count resets server-side.
   *  Uses the away path's OWN single-flight (independent of
   *  the threadlist catch-up path) so a threadlist pull at the same instant cannot starve the away-
   *  notification. A `kind:'clear'` descriptor (nothing unread+unmuted) dismisses the prior notification.
   *  Fire-and-forget. */
  private async pullAndRender(): Promise<void> {
    try {
      const result = await this.notificationFeed.query(
        this.awayAfter,
        this.prefs.previewMode(),
        this.convList.threadHwms(),
      );
      if (!result) return;
      await Promise.all(
        result.notifications.map((d) => this.adapter.showDescriptor(d)),
      );
    } catch {
      /* best-effort — a transient fetch failure just means no notification this cycle */
    }
  }
}
