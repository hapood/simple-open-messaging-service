import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { filter } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import { ConversationListService } from './conversation-list.service';
import { WebsocketService } from './websocket.service';
import { displayThreadName } from './model';
import { isAndroid, isTauri } from './runtime';
import { NotificationPrefsService } from './notification-prefs.service';
import { buildAwayBody, type AwayEntry, type TranslateFn } from './notif-text';

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
 *     sent you 7 messages while you were away" — and re-creates it (replacing the previous one via a
 *     shared tag) on each NEW_MESSAGE that arrives while unfocused. The shade therefore holds exactly
 *     ONE entry from us, no matter how many messages or conversations burst. A burst (several messages at
 *     once) is debounced — the first posts immediately and any that follow within a short window collapse
 *     into a single trailing re-post with the rolled-up count, so `renotify` never machine-guns the banner.
 *     The summary tallies only
 *     messages received during the current away-session (not the cumulative unread), so the wording is
 *     exact even when the user left with prior unread. The notification is dismissed the instant the
 *     window regains focus. Browser path = full feature (tag replace, renotify, sound toggle, click →
 *     focus, close-on-focus); the Tauri desktop shell posts once per away-session (its bridge exposes
 *     only a fire-and-forget `sendNotification({title,body})` — no tag replace, cancel, or sound).
 *
 * Stops the moment the window regains focus (the user is now looking at the app). Mobile Android is
 * excluded — in-app banner + FCM/WorkManager cover it there, and a title prefix on a mobile activity is
 * meaningless.
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

  /** Shared tag for the single summary notification — a new notification with this tag REPLACES the
   *  prior one instead of stacking, so the shade holds exactly one entry from us. Browser-only (the
   *  Tauri bridge has no tag concept). */
  private static readonly TAG = 'soms-away-summary';
  /** The live browser Notification instance, held so focus can `.close()` it. */
  private activeNotif: Notification | null = null;
  /** Tauri-only: the bridge can't replace/cancel, so post at most ONE notification per away-session
   *  (further messages still bump the (N) title prefix + list badges). Reset on focus. */
  private awayPosted = false;
  /** Per-thread tally of messages received during the CURRENT away-session (cleared on focus). Drives
   *  the summary body so "while you were away" reflects only messages that arrived while unfocused. */
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

  constructor() {
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
   *  (so a burst's tail can't post AFTER focus returns), close the live browser instance, re-arm the Tauri
   *  one-per-away-session gate, and clear the per-thread tally. Manual dismiss / auto-timeout do NOT call
   *  this — those only null the ref (see the `close` listener) and never suppress the next pop. */
  private dismissActive(): void {
    if (this.awayFlushTimer !== null) {
      clearTimeout(this.awayFlushTimer);
      this.awayFlushTimer = null;
    }
    this.awayPendingPost = false;
    if (this.activeNotif) {
      try {
        this.activeNotif.close();
      } catch {
        /* best-effort */
      }
      this.activeNotif = null;
    }
    this.awayPosted = false;
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

  /** Build the summary body from the away-session tally and post it: the browser path replaces the prior
   *  same-tag notification (one shade entry); the Tauri desktop path posts once per away-session (no
   *  replace available). Clears the pending-post flag so a lone message earns no redundant trailing post. */
  private postSummary(): void {
    const body = buildAwayBody([...this.awayDelta.values()], this.translate);
    if (body === null) return; // nothing to summarize (defensive — awayDelta should be non-empty here)
    this.awayPendingPost = false;

    // Tauri DESKTOP shell first (the user's directive: PC must show native system popups) — gated to
    // !isAndroid so mobile never takes this branch. The global bridge exposes only a fire-and-forget
    // sendNotification({title, body}): no tag, no cancel-by-id, no sound flag. Posting on every message
    // would pile up one entry per message (the very thing we're fixing), so post ONCE per away-session;
    // subsequent messages still bump the (N) title prefix + the per-thread unread badges. Full rolling
    // behavior is the browser path below.
    const tauriNotif = window.__TAURI__?.notification;
    if (isTauri() && !isAndroid() && tauriNotif) {
      if (this.awayPosted) return;
      this.awayPosted = true;
      try {
        tauriNotif.sendNotification({ title: this.baseTitle, body });
      } catch {
        /* best-effort */
      }
      return;
    }

    // Browser: a fixed tag means every new message REPLACES the prior notification (one shade entry,
    // no pile-up). `renotify: true` re-banners on each replace (Chromium-supported; Firefox ignores);
    // `silent` follows the Sound pref. Click focuses the window (a multi-sender summary can't deep-link
    // to one thread). The close listener is housekeeping only — it never suppresses the next pop
    // (auto-timeout would otherwise cap us to one pop per away-session, breaking "pop on every message").
    if (!isTauri() && 'Notification' in window && Notification.permission === 'granted') {
      if (!this.prefs.enabled()) return; // app-level master (the permission is terminal; this is the mute)
      try {
        // The TS DOM lib's NotificationOptions omits `renotify` (a Chromium-supported, spec-defined option
        // not yet typed). Extend it so the literal type-checks honestly instead of being cast away.
        const options: NotificationOptions & { renotify?: boolean } = {
          body,
          tag: UnreadAttentionService.TAG,
          silent: !this.prefs.sound(),
          renotify: true,
        };
        const n = new Notification(this.baseTitle, options);
        n.onclick = () => {
          window.focus();
          n.close();
        };
        n.addEventListener('close', () => {
          if (this.activeNotif === n) this.activeNotif = null;
        });
        this.activeNotif = n;
      } catch {
        /* best-effort */
      }
    }
  }
}
