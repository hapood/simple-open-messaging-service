import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { filter } from 'rxjs';
import { ConversationListService } from './conversation-list.service';
import { WebsocketService } from './websocket.service';
import { isAndroid, isTauri } from './runtime';

/**
 * Foreground "you have unread" attention for **PC desktop + browser** — the channels that lack a
 * background push path (mobile Android has FCM/WorkManager; the browser has Web Push for the
 * tab-closed case). When the window/tab loses focus while there are unread messages, this service:
 *
 *  1. Flashes the document title between the base title and "(N) SOMS". `document.title` drives BOTH
 *     a browser tab's title (with "(N)" badge prefix) AND — on Tauri desktop — the OS window title
 *     (Tauri syncs it automatically), so one mechanism covers both surfaces.
 *  2. Posts a system notification on each NEW_MESSAGE that arrives while unfocused: the browser
 *     `Notification` API (permission-gated) for the web build, or `window.__TAURI__.notification` for
 *     the desktop shell (requires the tauri-plugin-notification plugin). Falls back to title-flash-only
 *     if neither permission nor the plugin is available.
 *
 * Stops the moment the window regains focus (the user is now looking at the app). Mobile Android is
 * excluded — in-app banner + FCM/WorkManager cover it there, and title-flash on a mobile activity is
 * meaningless.
 */
@Injectable({ providedIn: 'root' })
export class UnreadAttentionService {
  private readonly convList = inject(ConversationListService);
  private readonly ws = inject(WebsocketService);

  /** The page's original title, captured at construction before any flashing mutates it. */
  private readonly baseTitle = typeof document !== 'undefined' ? document.title : 'SOMS';
  /** Whether the window/tab currently has focus. Drives the flash + notification gate. */
  private readonly focused = signal(true);
  private flashTimer?: ReturnType<typeof setInterval>;

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

    // React to unread changes: start/stop the title flash.
    effect(() => this.syncFlash(this.unreadTotal(), this.focused()));

    // A NEW_MESSAGE arriving while unfocused → system notification. The kernel's pull pipeline still
    // renders the bubble; this is just the "heads-up, look over here" tap on the shoulder.
    this.ws.eventSubject
      .pipe(filter((m) => m.event === 'NEW_MESSAGE'))
      .subscribe((m) => {
        if (!this.focused()) this.notify(m.data);
      });
  }

  private onFocusChange(focused: boolean): void {
    this.focused.set(focused);
    if (focused) {
      // Restore the title as soon as the user looks back.
      document.title = this.baseTitle;
    }
  }

  /** Start/stop the ~1s title flash. Runs inside an effect so it reacts to unread/focus changes. */
  private syncFlash(unread: number, focused: boolean): void {
    if (unread > 0 && !focused) {
      if (this.flashTimer) return; // already flashing
      let on = false;
      this.flashTimer = setInterval(() => {
        on = !on;
        document.title = on ? `(${this.unreadTotal()}) ${this.baseTitle}` : this.baseTitle;
      }, 1000);
    } else if (this.flashTimer) {
      clearInterval(this.flashTimer);
      this.flashTimer = undefined;
      document.title = this.baseTitle;
    }
  }

  /** Post a system notification for an unfocused NEW_MESSAGE. Browser Notification API or the Tauri
   *  notification plugin (whichever is available + permitted). Title/preview come from the SSE payload
   *  (same shape as FCM/Web Push: { threadId, messageId, contentType, ts, preview }). */
  private notify(data: unknown): void {
    const d = (data ?? {}) as { preview?: string; contentType?: string; threadId?: string };
    // Mute: a muted conversation must not trigger a heads-up notification. The server already
    // suppresses push + the away-notification snapshot; this guards the browser/Tauri system
    // notification for the in-tab case. The bubble still renders via SSE (mute is notification-only).
    if (d.threadId !== undefined) {
      const tid = Number(d.threadId);
      const item = this.convList.items().find((t) => t.threadId === tid);
      if (item?.muted) return;
    }
    const body = d.preview ?? this.labelFor(d.contentType);
    // Tauri DESKTOP shell first (the user's directive: PC must show native system popups) — gated to
    // !isAndroid so mobile never takes this branch.
    // never takes this branch (mobile background = SSE disconnected = no event; mobile foreground =
    // focused = no notify; either way the in-app banner + FCM/WorkManager cover mobile).
    const tauriNotif = window.__TAURI__?.notification;
    if (isTauri() && !isAndroid() && tauriNotif) {
      try {
        tauriNotif.sendNotification({ title: this.baseTitle, body });
      } catch {
        /* best-effort */
      }
      return;
    }
    if (!isTauri() && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(this.baseTitle, { body, tag: d.threadId ? `thread_${d.threadId}` : undefined });
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
