/**
 * The notification DISPLAY adapter — hides platform differences behind one polymorphic surface. The facade
 * ({@link UnreadAttentionService}, the in-tab "unread" attention path) selects ONE implementation at construction
 * by platform and delegates each "post / dismiss" to it, so the facade carries no platform branching beyond that
 * one-time selection. This mirrors the {@link RealtimeTransport} strategy used for the realtime downlink
 * (`websocket.service.ts` selects one transport by platform in its constructor).
 *
 * Each adapter shows a SINGLE rolling summary (the away-session tally composed by `buildAwayBody`) — sender(s) +
 * count, never message content. Every adapter wraps its platform's NATIVE notification bridge and maps the unified
 * `merge` param onto that bridge's native replace-by-id — the platform differences live here, in the JS layer:
 *  - {@link BrowserNotificationAdapter} — the Web Notifications API (`new Notification`); `merge` → `tag` (replace).
 *  - {@link TauriNotificationAdapter} — desktop Tauri bridge (`tauriSendNotification`); `merge` → `identifier`.
 *  - {@link AndroidNotificationAdapter} — Kotlin `SomsNotify` `@JavascriptInterface`; `merge` → `replace` (AWAY_NOTIF_ID).
 *
 * `show(text, merge)` is the two-parameter display call every adapter implements; `clear()` is a lifecycle method
 * (dismiss on focus regain) — not one of the two message parameters.
 */
export abstract class NotificationAdapter {
  /** Show / update a notification with the (already-composed) body text.
   *  `merge=true`  → fold this text into the already-posted notification (replace in place at the stable id/tag),
   *                  so the shade holds one entry.
   *  `merge=false` → post a fresh standalone entry. */
  abstract show(text: string, merge: boolean): void;

  /** Dismiss the active notification — the facade calls this when the window regains focus. */
  abstract clear(): void;
}
