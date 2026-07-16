import { NotificationAdapter } from './notification-adapter';
import { tauriSendNotification } from './runtime';

/**
 * Desktop Tauri shell (pc/mac/linux) system notification. The raw bridge call
 * (`window.__TAURI__.notification.sendNotification`) is EXPOSED as the typed `tauriSendNotification` accessor in
 * `runtime.ts`, which carries the plugin's native params (`title`, `body`, `identifier`). This adapter is the JS
 * layer that smooths the platform difference: it maps the unified `merge` param onto `identifier` — the native
 * replace-by-id (posting with the same identifier replaces the prior notification, so the shade holds one entry).
 *
 * Whether the OS notification daemon actually honors replacement-by-id is platform-dependent (reliable on
 * macOS/Windows; best-effort on Linux daemons) — that is the native layer's behavior, not this adapter's concern.
 *
 * Desktop-only: Android has its own Kotlin `SomsNotify` bridge + {@link AndroidNotificationAdapter}. The global
 * bridge exposes no cancel-by-id, so `clear()` cannot dismiss the posted notification from JS (it is replaced on
 * the next merged `show`, or auto-dismissed on tap).
 */
export class TauriNotificationAdapter extends NotificationAdapter {
  /** The page's original title (the notification title; Tauri also syncs `document.title` to the OS window). */
  private readonly baseTitle = typeof document !== 'undefined' ? document.title : 'SOMS';
  /** Stable identifier — a notification posted with this replaces the prior one (the native replace-by-id). */
  private static readonly STABLE_ID = 'soms-away-summary';

  show(text: string, merge: boolean): void {
    try {
      tauriSendNotification({
        title: this.baseTitle,
        body: text,
        identifier: merge ? TauriNotificationAdapter.STABLE_ID : undefined,
      });
    } catch {
      /* best-effort */
    }
  }

  clear(): void {
    // The global bridge exposes no cancel-by-id, so the posted desktop notification cannot be dismissed from JS.
    // It is replaced (via the stable identifier) on the next merged `show`, or auto-dismissed on tap.
  }
}
