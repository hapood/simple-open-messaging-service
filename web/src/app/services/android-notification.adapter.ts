import { NotificationAdapter } from './notification-adapter';
import type { NotificationDescriptor } from './notification-descriptor.model';

/**
 * Android notification via the Kotlin `SomsNotify` `@JavascriptInterface` (registered in `MainActivity`
 * alongside `SomsFcm` / `SomsShell` / `SomsBack`). This adapter forwards the WHOLE server-authored
 * descriptor as JSON to Kotlin (`SomsNotify.showDescriptor(json)`), which renders it natively
 * (`BigTextStyle(body)` + `setLargeIcon(icon bitmap)` + `setOnlyAlertOnce(!renotify)` + per-action
 * `addAction`). The native layer maps each stable per-thread tag to a stable Android notification ID, so a
 * newer descriptor replaces that thread's prior notification.
 *
 * Per the native-bridge rule, this adapter runs only on Android, so `window.SomsNotify` is guaranteed
 * present — call with `!`, never `?`.
 *
 * Dormant in practice: the WebView is never unfocused while the activity is alive, so the foreground
 * {@link UnreadAttentionService} never fires `showDescriptor` on Android — background delivery is owned
 * natively by the FCM / WorkManager / RealtimeService paths (which render the SAME descriptor from the
 * `/notification-feed/query` pull).
 */
export class AndroidNotificationAdapter extends NotificationAdapter {
  async showDescriptor(d: NotificationDescriptor): Promise<void> {
    window.SomsNotify!.showDescriptor(JSON.stringify(d));
  }

  async clear(): Promise<void> {
    window.SomsNotify!.clear();
  }
}
