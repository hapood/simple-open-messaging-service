import { NotificationAdapter } from './notification-adapter';
import { NotificationPrefsService } from './notification-prefs.service';
import type { NotificationDescriptor } from './notification-descriptor.model';

/**
 * Browser / PWA in-tab attention notification, via the Web Notifications API. The server-authored
 * {@link NotificationDescriptor} maps field-for-field onto `new Notification(title, options)`:
 *  - `tag` (+ `renotify`) → the replace-by-tag primitive (one shade entry, re-banner on replace);
 *  - `icon` → the composited stacked-avatar PNG (null → omit, the browser shows its default);
 *  - `silent` → the quiet flag (falls back to the Sound pref when the descriptor leaves it unset);
 *  - `actions` → the native action buttons (P2);
 *  - `kind:'clear'` → `.close()` the active notification (server-driven cancel).
 *
 * The app-level master (`enabled`) is the in-app mute (the browser permission itself is terminal). Click
 * focuses the window (a multi-sender summary cannot deep-link to one thread).
 */
export class BrowserNotificationAdapter extends NotificationAdapter {
  /** The live browser Notifications, keyed by `tag` so `clear()` (focus regain) can close them all AND so
   *  per-thread mode (N descriptors, one per `soms-thread-*` tag) keeps each card instead of overwriting a
   *  single slot. Same-`tag` replace-by-tag still works (the old one auto-closes; its `close` handler drops
   *  the stale entry). */
  private readonly active = new Map<string, Notification>();

  constructor(private readonly prefs: NotificationPrefsService) {
    super();
  }

  showDescriptor(d: NotificationDescriptor): void {
    if (d.kind === 'clear') {
      this.closeAll();
      return;
    }
    if (!this.prefs.enabled()) return; // app-level master (the permission is terminal; this is the mute)
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      // The TS DOM lib's NotificationOptions omits `renotify` (a Chromium-supported, spec-defined option
      // not yet typed). Extend it so the literal type-checks honestly instead of being cast away. `renotify`
      // requires a `tag`, so it is set only when the descriptor carries one.
      //
      // `actions` is deliberately NOT passed: in-page `new Notification` action buttons are display-only
      // (the `notificationclick` + `event.action` callback only fires in a ServiceWorkerGlobalScope, i.e.
      // for SW-posted notifications). Showing buttons that do nothing when tapped is misleading — the
      // foreground's real action surface is the in-app popup (real Angular click handlers). The SW
      // notification path (sw-push.js) DOES pass actions; they work there.
      const options: NotificationOptions & { renotify?: boolean } = {
        body: d.body,
        tag: d.tag,
        icon: d.icon ?? undefined,
        lang: d.lang,
        silent: d.silent ?? !this.prefs.sound(),
        data: d.data,
        renotify: d.renotify,
      };
      const n = new Notification(d.title, options);
      n.onclick = () => {
        window.focus();
        n.close();
      };
      n.addEventListener('close', () => {
        if (this.active.get(d.tag) === n) this.active.delete(d.tag);
      });
      this.active.set(d.tag, n);
    } catch {
      /* best-effort */
    }
  }

  clear(): void {
    this.closeAll();
  }

  private closeAll(): void {
    for (const n of this.active.values()) {
      try {
        n.close();
      } catch {
        /* best-effort */
      }
    }
    this.active.clear();
  }
}
