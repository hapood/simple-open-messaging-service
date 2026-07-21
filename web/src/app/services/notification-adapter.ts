import type { NotificationDescriptor } from './notification-descriptor.model';

/**
 * The notification DISPLAY adapter — hides platform differences behind one polymorphic surface. The facade
 * ({@link UnreadAttentionService}, the in-tab "unread" attention path) selects ONE implementation at
 * construction by platform and delegates each "show / dismiss" to it, so the facade carries no platform
 * branching beyond that one-time selection. This mirrors the {@link RealtimeTransport} strategy used for
 * the realtime downlink (`websocket.service.ts` selects one transport by platform in its constructor).
 *
 * The server-authored {@link NotificationDescriptor} carries BOTH the content AND the presentation
 * semantics (`tag` = replace-in-place vs new, `kind` = template incl. `'clear'` = cancel, `icon`, `body`,
 * `actions`). Each adapter maps it onto its platform's NATIVE notification bridge:
 *  - {@link BrowserNotificationAdapter} — the Web Notifications API (`new Notification`); `tag` → replace,
 *    `icon` → the composited stacked avatar, `actions` → buttons.
 *  - {@link TauriNotificationAdapter} — desktop Tauri bridge (`tauriSendNotification`); `tag` → `identifier`.
 *  - {@link AndroidNotificationAdapter} — Kotlin `SomsNotify` `@JavascriptInterface`; forwards the whole
 *    descriptor as JSON for Kotlin to render natively (the WebView is never unfocused on Android, so this
 *    path is dormant — Android notifications come from the native FCM/WorkManager paths).
 *
 * `showDescriptor(d)` is the single display call every adapter implements; `clear()` is a lifecycle method
 * (dismiss on focus regain). A `kind:'clear'` descriptor also dismisses (server-driven cancel).
 */
export abstract class NotificationAdapter {
  /** Show / update / dismiss a notification per the server-authored descriptor. `tag` is the replace-by-id
   *  primitive (same tag replaces; unique tags stack). `kind:'clear'` cancels the tagged notification. */
  abstract showDescriptor(d: NotificationDescriptor): void;

  /** Dismiss the active notification — the facade calls this when the window regains focus. */
  abstract clear(): void;
}
