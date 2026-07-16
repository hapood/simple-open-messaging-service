import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { filter } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import { ConversationListService } from './conversation-list.service';
import { WebsocketService } from './websocket.service';
import { displayThreadName } from './model';
import { isAndroidNative, isTauri } from './runtime';
import { NotificationPrefsService } from './notification-prefs.service';
import { buildAwayBody, type AwayEntry, type TranslateFn } from './notif-text';
import { NotificationAdapter } from './notification-adapter';
import { BrowserNotificationAdapter } from './browser-notification.adapter';
import { TauriNotificationAdapter } from './tauri-notification.adapter';
import { AndroidNotificationAdapter } from './android-notification.adapter';

/**
 * Foreground "you have unread" attention for **PC desktop + browser** — the channels that lack a
 * background push path (mobile Android has FCM/WorkManager; the browser has Web Push for the
 * tab-closed case). When the window/tab loses focus while there are unread messages, this service:
 *
 *  1. Prefixes the document title with the unread count — "(N) SOMS" — while the window is unfocused
 *     (the Slack/Discord/Telegram convention: a static prefix, NOT a blinking toggle). `document.title`
 *     drives BOTH a browser tab's title AND — on Tauri desktop — the OS window title (Tauri syncs it
 *     automatically), so one mechanism covers both surfaces.
 *  2. Posts a SINGLE rolling "away messages" summary system notification — e.g. "Alice, Bob and others
 *     sent you 7 messages" — and re-creates it (replacing the previous one) on each NEW_MESSAGE that
 *     arrives while unfocused. The shade therefore holds exactly ONE entry from us, no matter how many
 *     messages or conversations burst. A burst (several messages at once) is debounced — the first posts
 *     immediately and any that follow within a short window collapse into a single trailing re-post with the
 *     rolled-up count, so `renotify` never machine-guns the banner. The summary tallies only messages received
 *     during the current away-session (not the cumulative unread), so the count is exact even when the user
 *     left with prior unread. The notification is dismissed the instant the window regains focus. The actual
 *     post/dismiss is delegated to a per-platform {@link NotificationAdapter}, each wrapping its platform's native
 *     notification bridge and mapping `merge` onto that bridge's native replace-by-id (browser = Notification-API
 *     `tag` + renotify + sound toggle + click→focus + close-on-focus; desktop Tauri = `identifier`; Android = the
 *     Kotlin `SomsNotify` bridge's `replace`/AWAY_NOTIF_ID), selected once at construction so this class carries no
 *     platform branching.
 *
 * Stops the moment the window regains focus (the user is now looking at the app). Mobile Android selects the
 * AndroidNotificationAdapter, but it is dormant here — the WebView is never unfocused while the activity is alive,
 * so this service never fires `show`; Android's notifications come from the native paths (FCM/WorkManager/
 * RealtimeService), and a title prefix on a mobile activity is meaningless.
 */
@Injectable({ providedIn: 'root' })
export class UnreadAttentionService {
  private readonly convList = inject(ConversationListService);
  private readonly ws = inject(WebsocketService);
  private readonly prefs = inject(NotificationPrefsService);
  private readonly i18n = inject(TranslocoService);

  /** The page's original title, captured at construction before any prefix is applied. */
  private readonly baseTitle = typeof document !== 'undefined' ? document.title : 'SOMS';
  /** Whether the window/tab currently has focus. Drives the title-prefix + notification gate. */
  private readonly focused = signal(true);

  /** Total unread across all conversations — drives the "(N)" badge count. */
  private readonly unreadTotal = computed(() =>
    this.convList.items().reduce((sum, it) => sum + (it.unreadCount ?? 0), 0),
  );

  /** Per-thread tally of messages received during the CURRENT away-session (cleared on focus). Drives
   *  the summary body so it reflects only messages that arrived while unfocused. */
  private readonly awayDelta = new Map<number, AwayEntry>();
  /** Coalesce a burst (several messages in <DEBOUNCE_MS) into a single notification re-post: the FIRST
   *  message posts immediately (leading edge — the user is tapped without delay); messages that follow
   *  within the window are folded into {@link awayDelta} only, then ONE trailing flush re-posts with the
   *  rolled-up count. Stops a machine-gun of `renotify` re-banners when many messages land at once. */
  private static readonly DEBOUNCE_MS = 250;
  /** Pending trailing-flush timer, or null when not in a coalescing window. */
  private awayFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** True when messages have been tallied since the last {@link postSummary} — gates the trailing flush so
   *  a lone message (no follow-up) earns no redundant second re-banner. */
  private awayPendingPost = false;

  /** Translate bound to the live TranslocoService (arrow preserves `this`). Identity-fallback so a
   *  missing key never blanks the notification. */
  private readonly translate: TranslateFn = (key, params): string =>
    this.i18n.translate(key, params) ?? key;

  /** Per-platform notification display adapter (browser / desktop-Tauri / Android), selected once at
   *  construction — this class delegates every post/dismiss to it and carries no platform branching. */
  private readonly adapter!: NotificationAdapter;

  constructor() {
    // Select the per-platform display adapter ONCE (mirrors WebsocketService's transport selection): each adapter
    // wraps its platform's native notification bridge and maps the unified `merge` param onto that bridge's native
    // replace-by-id (browser: tag; desktop Tauri: identifier; Android: Kotlin SomsNotify replace). No branching
    // elsewhere. (On Android the JS path is dormant: the WebView is never unfocused while alive, so background
    // delivery is owned natively by FCM/WorkManager/RealtimeService.)
    this.adapter = isAndroidNative()
      ? new AndroidNotificationAdapter()
      : isTauri()
        ? new TauriNotificationAdapter()
        : new BrowserNotificationAdapter(this.prefs);
    if (typeof document === 'undefined') return;
    // Track focus. visibilitychange catches tab-switch; blur/focus catches the window losing focus to
    // another app without the tab hiding (the desktop case the user specifically wants covered).
    window.addEventListener('blur', () => this.onFocusChange(false), { passive: true });
    window.addEventListener('focus', () => this.onFocusChange(true), { passive: true });
    document.addEventListener('visibilitychange', () =>
      this.onFocusChange(document.visibilityState === 'visible'),
    );

    // React to unread/focus changes: apply or clear the "(N)" title prefix.
    effect(() => this.syncTitle(this.unreadTotal(), this.focused()));

    // A NEW_MESSAGE arriving while unfocused → (re)post the single rolling summary notification. The
    // kernel's pull pipeline still renders the bubble; this is just the "heads-up, look over here" tap.
    this.ws.eventSubject
      .pipe(filter((m) => m.event === 'NEW_MESSAGE'))
      .subscribe((m) => {
        if (!this.focused()) this.notify(m.data);
      });
  }

  private onFocusChange(focused: boolean): void {
    // The effect owns document.title; flipping `focused` re-runs it and restores the base title.
    this.focused.set(focused);
    if (focused) this.dismissActive();
  }

  /** Apply the static "(N)" prefix while there are unreads AND the window is unfocused (the
   *  Slack/Discord/Telegram convention — no blinking); the base title otherwise. Runs inside an
   *  effect so it reacts to unread/focus changes. */
  private syncTitle(unread: number, focused: boolean): void {
    document.title =
      unread > 0 && !focused ? `(${this.unreadTotal()}) ${this.baseTitle}` : this.baseTitle;
  }

  /** Tear down the away notification when the user returns to the tab: cancel any pending trailing-flush
   *  (so a burst's tail can't post AFTER focus returns), dismiss the active notification via the adapter
   *  (browser closes it; Android cancels by id; desktop Tauri has no cancel), and clear the per-thread tally. */
  private dismissActive(): void {
    if (this.awayFlushTimer !== null) {
      clearTimeout(this.awayFlushTimer);
      this.awayFlushTimer = null;
    }
    this.awayPendingPost = false;
    this.adapter.clear(); // dismiss the active notification (browser closes; Android cancels by id; desktop no-op)
    this.awayDelta.clear();
  }

  /** A NEW_MESSAGE arrived while unfocused: tally it, then (re)post the single rolling summary
   *  notification — DEBOUNCED so a burst collapses to a leading post + a trailing flush rather than one
   *  re-post per message (which would `renotify`-banner in a flicker). The tally is always immediate
   *  (the count stays exact); only the post is throttled. */
  private notify(data: unknown): void {
    if (!this.accumulate(data)) return; // unparseable threadId or muted — nothing to post
    this.schedulePost();
  }

  /** Fold one message into {@link awayDelta} (the per-thread away-session tally) and mark a post pending.
   *  Returns false (no tally) for an unparseable threadId or a muted conversation — those must not
   *  trigger a heads-up. Synchronous and immediate so the count is never lost to the debounce window. */
  private accumulate(data: unknown): boolean {
    const d = (data ?? {}) as { threadId?: string };
    const tid = d.threadId !== undefined ? Number(d.threadId) : undefined;
    if (tid === undefined || !Number.isFinite(tid)) return false;
    const item = this.convList.items().find((t) => t.threadId === tid);
    // Mute: a muted conversation must not trigger a heads-up notification. The server already
    // suppresses push + the away-notification snapshot; this guards the browser/Tauri system
    // notification for the in-tab case. The bubble still renders via SSE (mute is notification-only).
    if (item?.muted) return false;
    const name = (item && displayThreadName(item)) || this.baseTitle;
    const prev = this.awayDelta.get(tid);
    this.awayDelta.set(tid, { name, count: (prev?.count ?? 0) + 1 });
    this.awayPendingPost = true;
    return true;
  }

  /** Leading-edge + trailing-flush throttle. No active window → post now (leading) and arm the window;
   *  window active → coalesce (the trailing flush carries this message's count). */
  private schedulePost(): void {
    if (this.awayFlushTimer !== null) return; // within a coalescing window — wait for the trailing flush
    this.postSummary(); // leading edge: tap the user without delay
    this.armWindow();
  }

  private armWindow(): void {
    this.awayFlushTimer = setTimeout(() => {
      this.awayFlushTimer = null;
      // Trailing flush: if messages landed after the leading post, re-post once with the rolled-up count.
      // No re-arm — the next message becomes a fresh leading edge.
      if (this.awayPendingPost) this.postSummary();
    }, UnreadAttentionService.DEBOUNCE_MS);
  }

  /** Build the summary body from the away-session tally and hand it to the per-platform adapter, merged into the
   *  single rolling summary. Clears the pending-post flag so a lone message earns no redundant trailing post. */
  private postSummary(): void {
    const body = buildAwayBody([...this.awayDelta.values()], this.translate);
    if (body === null) return; // nothing to summarize (defensive — awayDelta should be non-empty here)
    this.awayPendingPost = false;
    // Delegate the post to the per-platform adapter. `merge=true` folds into the single rolling summary via each
    // platform's native replace-by-id (browser: tag; desktop: identifier; Android: AWAY_NOTIF_ID).
    this.adapter.show(body, true);
  }
}
