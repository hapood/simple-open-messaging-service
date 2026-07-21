import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { filter } from 'rxjs';
import { ConversationListService } from './conversation-list.service';
import { WebsocketService } from './websocket.service';
import { isAndroidNative, isTauri } from './runtime';
import { NotificationPrefsService } from './notification-prefs.service';
import { MissedSyncService } from './missed-sync.service';
import { NotifPopupService } from './notif-popup.service';
import { NotificationAdapter } from './notification-adapter';
import { BrowserNotificationAdapter } from './browser-notification.adapter';
import { TauriNotificationAdapter } from './tauri-notification.adapter';
import { AndroidNotificationAdapter } from './android-notification.adapter';

/**
 * Foreground "you have unread" attention for **PC desktop + browser** — the channels that lack a
 * background push path (mobile Android has FCM/WorkManager; the browser has Web Push for the tab-closed
 * case). When the window/tab loses focus while there are unread messages, this service:
 *
 *  1. Prefixes the document title with the unread count — "(N) SOMS" — while the window is unfocused
 *     (the Slack/Discord/Telegram convention: a static prefix, NOT a blinking toggle). `document.title`
 *     drives BOTH a browser tab's title AND — on Tauri desktop — the OS window title (Tauri syncs it
 *     automatically), so one mechanism covers both surfaces.
 *  2. On each NEW_MESSAGE arriving while unfocused, **debounced-pulls** `/notifications/missed` (no cursor
 *     → the current unread snapshot) and renders the server-authored descriptor(s) via the per-platform
 *     {@link NotificationAdapter}. A burst collapses into one trailing pull (the server composes the body +
 *     the stacked-avatar icon, so there is no local tally/composition). The notification is dismissed the
 *     instant the window regains focus.
 *
 * Stops the moment the window regains focus (the user is now looking at the app). Mobile Android selects the
 * AndroidNotificationAdapter, but it is dormant here — the WebView is never unfocused while the activity is
 * alive, so this service never fires; Android's notifications come from the native paths
 * (FCM/WorkManager/RealtimeService), and a title prefix on a mobile activity is meaningless.
 */
@Injectable({ providedIn: 'root' })
export class UnreadAttentionService {
  private readonly convList = inject(ConversationListService);
  private readonly ws = inject(WebsocketService);
  private readonly prefs = inject(NotificationPrefsService);
  private readonly missedSync = inject(MissedSyncService);
  private readonly popup = inject(NotifPopupService);

  /** The page's original title, captured at construction before any prefix is applied. */
  private readonly baseTitle = typeof document !== 'undefined' ? document.title : 'SOMS';
  /** Whether the window/tab currently has focus. Drives the title-prefix + notification gate. */
  private readonly focused = signal(true);

  /** Total unread across all conversations — drives the "(N)" badge count. */
  private readonly unreadTotal = computed(() =>
    this.convList.items().reduce((sum, it) => sum + (it.unreadCount ?? 0), 0),
  );

  /** Coalesce a burst of NEW_MESSAGE frames into one trailing missed-summary pull + render. The server
   *  composes the descriptor, so a single debounced fetch (not a per-message post) is enough. */
  private static readonly DEBOUNCE_MS = 300;
  private awayFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Per-platform notification display adapter (browser / desktop-Tauri / Android), selected once at
   *  construction — this class delegates every render to it and carries no platform branching. */
  private readonly adapter!: NotificationAdapter;

  constructor() {
    // Select the per-platform display adapter ONCE (mirrors WebsocketService's transport selection).
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

    // A NEW_MESSAGE arriving while unfocused → schedule a debounced pull + render. The kernel's pull
    // pipeline still renders the bubble; this is just the "heads-up, look over here" tap.
    this.ws.eventSubject
      .pipe(filter((m) => m.event === 'NEW_MESSAGE'))
      .subscribe(() => {
        if (!this.focused()) this.scheduleRender();
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

  /** Tear down the away notification when the user returns to the tab: cancel any pending pull (so a
   *  burst's trailing render can't fire AFTER focus returns), dismiss the system notification, and clear
   *  the in-app popup. */
  private dismissActive(): void {
    if (this.awayFlushTimer !== null) {
      clearTimeout(this.awayFlushTimer);
      this.awayFlushTimer = null;
    }
    this.adapter.clear();
    this.popup.clear();
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

  /** Pull the current unread snapshot (the away-notification descriptors) and render each via the adapter
   *  AND the in-app popup. Uses the away path's OWN single-flight (independent of the threadlist catch-up
   *  path) so a threadlist pull at the same instant cannot starve the away-notification. A `kind:'clear'`
   *  descriptor (nothing unread+unmuted) dismisses the prior notification/popup. Fire-and-forget. */
  private async pullAndRender(): Promise<void> {
    try {
      const notifications = await this.missedSync.fetchAwayNotifications(this.convList.missedCursor());
      for (const d of notifications) this.adapter.showDescriptor(d);
      // The in-app popup is the reliable action surface on platforms where in-page Notification buttons
      // don't fire; show() handles `clear` (dismiss) + replace-by-tag.
      this.popup.show(notifications);
    } catch {
      /* best-effort — a transient fetch failure just means no notification this cycle */
    }
  }
}
