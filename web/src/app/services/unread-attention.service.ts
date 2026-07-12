import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { filter } from 'rxjs';
import { ConversationListService } from './conversation-list.service';
import { WebsocketService } from './websocket.service';
import { displayThreadName } from './model';
import { isAndroid, isTauri } from './runtime';

/**
 * Foreground "you have unread" attention for **PC desktop + browser** — the channels that lack a
 * background push path (mobile Android has FCM/WorkManager; the browser has Web Push for the
 * tab-closed case). When the window/tab loses focus while there are unread messages, this service:
 *
 *  1. Prefixes the document title with the unread count — "(N) SOMS" — while the window is unfocused
 *     (the Slack/Discord/Telegram convention: a static prefix, NOT a blinking toggle). `document.title`
 *     drives BOTH a browser tab's title AND — on Tauri desktop — the OS window title (Tauri syncs it
 *     automatically), so one mechanism covers both surfaces.
 *  2. Posts a system notification on each NEW_MESSAGE that arrives while unfocused: the browser
 *     `Notification` API (permission-gated) for the web build, or `window.__TAURI__.notification` for
 *     the desktop shell (requires the tauri-plugin-notification plugin). Falls back to title-prefix-only
 *     if neither permission nor the plugin is available.
 *
 * Stops the moment the window regains focus (the user is now looking at the app). Mobile Android is
 * excluded — in-app banner + FCM/WorkManager cover it there, and a title prefix on a mobile activity is
 * meaningless.
 */
@Injectable({ providedIn: 'root' })
export class UnreadAttentionService {
  private readonly convList = inject(ConversationListService);
  private readonly ws = inject(WebsocketService);

  /** The page's original title, captured at construction before any prefix is applied. */
  private readonly baseTitle = typeof document !== 'undefined' ? document.title : 'SOMS';
  /** Whether the window/tab currently has focus. Drives the title-prefix + notification gate. */
  private readonly focused = signal(true);

  /** Total unread across all conversations — drives the "(N)" badge count. */
  private readonly unreadTotal = computed(() =>
    this.convList.items().reduce((sum, it) => sum + (it.unreadCount ?? 0), 0),
  );

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

    // A NEW_MESSAGE arriving while unfocused → system notification. The kernel's pull pipeline still
    // renders the bubble; this is just the "heads-up, look over here" tap on the shoulder.
    this.ws.eventSubject
      .pipe(filter((m) => m.event === 'NEW_MESSAGE'))
      .subscribe((m) => {
        if (!this.focused()) this.notify(m.data);
      });
  }

  private onFocusChange(focused: boolean): void {
    // The effect owns document.title; flipping `focused` re-runs it and restores the base title.
    this.focused.set(focused);
  }

  /** Apply the static "(N)" prefix while there are unreads AND the window is unfocused (the
   *  Slack/Discord/Telegram convention — no blinking); the base title otherwise. Runs inside an
   *  effect so it reacts to unread/focus changes. */
  private syncTitle(unread: number, focused: boolean): void {
    document.title =
      unread > 0 && !focused ? `(${this.unreadTotal()}) ${this.baseTitle}` : this.baseTitle;
  }

  /** Post a system notification for an unfocused NEW_MESSAGE. Browser Notification API or the Tauri
   *  notification plugin (whichever is available + permitted). Mainstream IM shape (WhatsApp /
   *  Telegram / Discord): title = the conversation name (peer nickname / group name, alias-aware),
   *  body = the message preview or a content-type label. The name comes from the live list (NOT the
   *  SSE payload, which can't resolve it cheaply); it falls back to the app name when the thread
   *  isn't snapshotted yet. */
  private notify(data: unknown): void {
    const d = (data ?? {}) as { preview?: string; contentType?: string; threadId?: string };
    const tid = d.threadId !== undefined ? Number(d.threadId) : undefined;
    const item = tid !== undefined ? this.convList.items().find((t) => t.threadId === tid) : undefined;
    // Mute: a muted conversation must not trigger a heads-up notification. The server already
    // suppresses push + the away-notification snapshot; this guards the browser/Tauri system
    // notification for the in-tab case. The bubble still renders via SSE (mute is notification-only).
    if (item?.muted) return;
    const title = (item && displayThreadName(item)) || this.baseTitle;
    const body = d.preview ?? this.labelFor(d.contentType);
    // Tauri DESKTOP shell first (the user's directive: PC must show native system popups) — gated to
    // !isAndroid so mobile never takes this branch (mobile background = SSE disconnected = no event;
    // mobile foreground = focused = no notify; either way the in-app banner + FCM/WorkManager cover
    // mobile).
    const tauriNotif = window.__TAURI__?.notification;
    if (isTauri() && !isAndroid() && tauriNotif) {
      try {
        tauriNotif.sendNotification({ title, body });
      } catch {
        /* best-effort */
      }
      return;
    }
    if (!isTauri() && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, { body, tag: tid !== undefined ? `thread_${tid}` : undefined });
      } catch {
        /* best-effort */
      }
    }
  }

  private labelFor(contentType?: string): string {
    switch (contentType) {
      case 'IMAGE': return '📷 Photo';
      case 'VIDEO': return '🎬 Video';
      case 'FILE': return '📎 File';
      case 'AUDIO': return '🎤 Voice message';
      case 'INVITE': return '🔗 Group invite';
      default: return 'New message';
    }
  }
}
