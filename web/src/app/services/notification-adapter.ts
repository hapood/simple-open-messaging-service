import type { NotificationDescriptor } from './notification-descriptor.model';

/**
 * The notification DISPLAY adapter — hides platform differences behind one polymorphic surface. The facade
 * ({@link UnreadAttentionService}, the in-tab "unread" attention path) selects ONE implementation at
 * construction by platform and delegates each "show / dismiss" to it, so the facade carries no platform
 * branching beyond that one-time selection. This mirrors the {@link RealtimeTransport} strategy used for
 * the realtime downlink (`websocket.service.ts` selects one transport by platform in its constructor).
 *
 * The client-authored {@link NotificationDescriptor} carries BOTH the content AND the presentation
 * semantics (`tag` = replace-in-place vs new, `kind` = template, `icon`, `body`,
 * routing data). Each adapter maps it onto its platform's NATIVE notification bridge:
 *  - {@link BrowserNotificationAdapter} — the Web Notifications API (`new Notification`); `tag` → replace,
 *    `icon` → the client-selected icon.
 *  - {@link TauriNotificationAdapter} — Rust desktop commands, keyed by thread ID where OS handles are supported.
 * Android notification presentation is owned entirely by the native runtime.
 *
 * `showDescriptor(d)` is the single display call every adapter implements; `clear()` is a lifecycle method
 * (dismiss on focus regain). Both are async — the browser adapter awaits its SW registration's
 * `showNotification` / `getNotifications`.
 */
export abstract class NotificationAdapter {
  /** Show or update a notification per the client-authored descriptor. `tag` is the replace-by-id primitive
   * (same tag replaces; unique tags stack). */
  abstract showDescriptor(d: NotificationDescriptor): Promise<void>;

  /** Dismiss the active notification — the facade calls this when the window regains focus. */
  abstract clear(): Promise<void>;
}
