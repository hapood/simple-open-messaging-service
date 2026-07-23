import { NotificationAdapter } from './notification-adapter';
import { tauriSendNotification } from './runtime';
import type { NotificationDescriptor } from './notification-descriptor.model';

/**
 * Desktop Tauri shell (pc/mac/linux) system notification. The raw bridge call
 * (`window.__TAURI__.notification.sendNotification`) is EXPOSED as the typed `tauriSendNotification` accessor
 * in `runtime.ts`, which carries the plugin's native params (`title`, `body`, `identifier`). This adapter
 * maps the server-authored {@link NotificationDescriptor} onto that bridge: `tag` → `identifier` (the native
 * replace-by-id — posting with the same identifier replaces the prior notification). The Tauri bridge does
 * not expose `icon` / `actions` / cancel-by-id, so those are dropped here (desktop best-effort).
 *
 * Whether the OS notification daemon actually honors replacement-by-id is platform-dependent (reliable on
 * macOS/Windows; best-effort on Linux daemons) — that is the native layer's behavior, not this adapter's
 * concern.
 *
 * Desktop-only: Android has its own Kotlin `SomsNotify` bridge + {@link AndroidNotificationAdapter}.
 */
export class TauriNotificationAdapter extends NotificationAdapter {
  async showDescriptor(d: NotificationDescriptor): Promise<void> {
    if (d.kind === 'clear') return; // the bridge exposes no cancel-by-id → nothing to dismiss
    try {
      tauriSendNotification({ title: d.title, body: d.body, identifier: d.tag });
    } catch {
      /* best-effort */
    }
  }

  async clear(): Promise<void> {
    // The global bridge exposes no cancel-by-id, so the posted desktop notification cannot be dismissed from
    // JS. It is replaced (via the stable identifier) on the next `showDescriptor`, or auto-dismissed on tap.
  }
}
