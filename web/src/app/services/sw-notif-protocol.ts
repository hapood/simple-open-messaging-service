/**
 * The SW↔page message protocol for shade-notification actions — the SINGLE source of truth for the
 * `data.type` discriminants. The push service worker (web/public/push/sw-push.js) can't reach the Angular
 * layer directly, so a `notificationclick` (per-card dismiss, body-tap deep-link) postMessages the page;
 * `UnreadAttentionService.onSwMessage` routes on `type`.
 *
 * The SW is a classic script (no imports), so scripts/gen-sw-config.mjs mirrors these `type` strings into
 * public/push/sw-config.js as `self.__SOMS_NOTIF_MSG__` (loaded via importScripts). Edit the constants HERE
 * + re-run `npm run prebuild` — never hand-edit sw-config.js. A typo in a `type` string is a SILENT
 * breakage (the message is ignored), which is exactly why the two sides must share one source.
 */

/** The `data.type` discriminant on a SW→page postMessage. */
export const SOMS_NOTIF_MSG = {
  /** A per-thread dismiss: advance that thread's HWM to `seq` (stop re-firing until newer messages). */
  DISMISS: 'soms-notif-dismiss',
  /** A body-tap deep-link: open the thread (`threadId`) in the chat pane. */
  OPEN: 'soms-notif-open',
  /** Push worker asks a live page with healthy SSE to take over notification aggregation. */
  CLAIM: 'soms-notif-claim',
} as const;

/** A SW→page postMessage payload (the `type` selects which fields matter). */
export interface SwNotifMessage {
  type: (typeof SOMS_NOTIF_MSG)[keyof typeof SOMS_NOTIF_MSG];
  threadId?: number;
  seq?: number;
}
