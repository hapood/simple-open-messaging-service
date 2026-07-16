import { NotificationAdapter } from './notification-adapter';
import { NotificationPrefsService } from './notification-prefs.service';

/**
 * Browser / PWA in-tab attention notification, via the Web Notifications API. A shared stable `tag` means a new
 * notification REPLACES the prior one (one shade entry, no pile-up); `renotify: true` re-banners on each replace
 * (Chromium-supported; Firefox ignores). `silent` follows the Sound pref; the master switch (`enabled`) is the
 * in-app mute (the browser permission itself is terminal). Click focuses the window (a multi-sender summary
 * cannot deep-link to one thread). `merge=false` omits the tag so the entry stacks instead of replacing.
 *
 * Lifted verbatim from the old browser branch of `UnreadAttentionService.postSummary` — only its home changed.
 */
export class BrowserNotificationAdapter extends NotificationAdapter {
  /** Shared tag for the single summary notification — a new notification with this tag REPLACES the prior one
   *  instead of stacking, so the shade holds exactly one entry from us. */
  private static readonly TAG = 'soms-away-summary';

  /** The page's original title (the notification title). */
  private readonly baseTitle = typeof document !== 'undefined' ? document.title : 'SOMS';
  /** The live browser Notification instance, held so `clear()` can `.close()` it on focus regain. */
  private activeNotif: Notification | null = null;

  constructor(private readonly prefs: NotificationPrefsService) {
    super();
  }

  show(text: string, merge: boolean): void {
    if (!this.prefs.enabled()) return; // app-level master (the permission is terminal; this is the mute)
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      // The TS DOM lib's NotificationOptions omits `renotify` (a Chromium-supported, spec-defined option not yet
      // typed). Extend it so the literal type-checks honestly instead of being cast away. `renotify` requires a
      // `tag`, so it is set only when merging.
      const options: NotificationOptions & { renotify?: boolean } = {
        body: text,
        tag: merge ? BrowserNotificationAdapter.TAG : undefined,
        silent: !this.prefs.sound(),
        renotify: merge,
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

  clear(): void {
    if (this.activeNotif) {
      try {
        this.activeNotif.close();
      } catch {
        /* best-effort */
      }
      this.activeNotif = null;
    }
  }
}
