/**
 * The notification descriptor — the web-side mirror of the backend `NotificationDescriptor`
 * (src/notification/notification-descriptor.ts). The server authors BOTH the content (localized title/body
 * + composited stacked-avatar icon) AND the presentation semantics (`tag` = replace-in-place vs new,
 * `kind` = template, `actions` = buttons); every client renderer (the Web Push SW, the foreground Angular
 * adapter) consumes it verbatim with zero composition logic. Kept hand-mirrored (not generated) because the
 * backend type lives in the NestJS app and the web is a separate Angular build.
 *
 * Mirrors the Web Notifications API `NotificationOptions` shape so `showNotification(title, opts)` maps
 * field-for-field; Android maps to `NotificationCompat.Builder`.
 */

export interface NotifAction {
  /** The action id the client reports back via `POST /notifications/action` (P2). */
  id: string;
  /** Localized button label. */
  title: string;
  style?: 'default' | 'suggested' | 'destructive';
  /** `'text'` = inline reply input; `'button'` = tap. */
  type?: 'button' | 'text';
}

export interface NotificationDescriptor {
  /** Stable id; posting the same tag REPLACES (coalesce). `'soms-away'` = the away-summary; unique = new. */
  tag: string;
  /** Template/action discriminator: `'message-summary'` | `'clear'` | (extensible). */
  kind: string;
  title: string;
  body: string;
  /** The locale the copy was rendered in (echoes the negotiated Accept-Language). */
  lang: string;
  /** URL to the server-composited stacked-avatar PNG; null → use the app icon. */
  icon: string | null;
  /** Re-alert on replace (false = silent update after the first post). */
  renotify: boolean;
  /** Quiet update (no sound). */
  silent?: boolean;
  /** Buttons — kind-dependent. P1 ships `[]`. */
  actions: NotifAction[];
  /** Routing payload, opaque to the server. `message-summary` carries the HWM cursor `(threadId, seq)` — the
   *  newest message the summary covers; mark-all-read advances the client's high-water mark to it (the server
   *  clears every active thread up to that ceiling). */
  data: { threadId?: number; seq?: number; [k: string]: unknown };
}

/** The forward-pagination cursor for `POST /notifications/missed` — the client's last-accounted message
 *  `(threadId, seq)` (the backend resolves it to the internal BigInt `id` it never exposes). Absent →
 *  snapshot (the away-notification / initial hydrate). */
export interface MissedCursor {
  threadId: number;
  seq: number;
}
