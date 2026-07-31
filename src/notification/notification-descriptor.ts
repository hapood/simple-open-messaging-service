import type { SupportedLocale } from '../common/locale.js';

/**
 * The notification descriptor — the server-authored presentation + content contract every client renders.
 * Mirrors the Web Notifications API `NotificationOptions` shape so each client maps it 1:1 onto its native
 * notification API (Web `showNotification`, Android `NotificationCompat.Builder`, Tauri bridge), and adds a
 * SOMS-specific `kind` discriminator + routing `data`. This is the single source of truth — the server
 * authors the copy once, where previously each client composed its own notification text (the Web service
 * worker, the Kotlin foreground service) and the wording drifted across platforms.
 *
 * Design (see the approved plan): the wake-up push signal stays identity-only; the client pulls
 * `/notifications/missed` and renders the descriptor(s) verbatim. The backend decides both WHAT the
 * notification shows (title/body/icon, server-localized) AND how it behaves relative to an existing one
 * (`tag` = replace-in-place vs new; `kind` = template + action set; `actions` = buttons).
 */

/** Stable tag for the single coalesced away-summary notification — posting with this tag REPLACES the
 *  prior one (the universal Web/Android replace-by-tag/id primitive), so the shade holds one entry. */
export const AWAY_SUMMARY_TAG = 'soms-away';

/** A button on the notification. Maps to Web Push `actions[]` / Android `addAction` (+ `RemoteInput` when
 *  `type:'text'`). `id` is what the client reports back via `POST /notifications/action`. */
export interface NotifAction {
  id: string;
  /** Localized button label. */
  title: string;
  style?: 'default' | 'suggested' | 'destructive';
  /** `'text'` = an inline reply input (Web Push action type text / Android RemoteInput); `'button'` = tap. */
  type?: 'button' | 'text';
}

/**
 * `kind` discriminators — select the client's render template + which `actions` apply. Open set; the
 * summary ships two concrete values today:
 *  - `'message-summary'` — the coalesced cross-thread "X sent you N messages" away notification.
 *  - `'clear'`           — tells the client to CANCEL the notification with this `tag` (server-driven
 *                          dismiss when nothing is unread+unmuted; replaces the client-side empty-cancel).
 * Future kinds (`'single-message'` with a per-thread reply action, `'friend-request'`, …) extend this union.
 */
export type NotificationKind = 'message-summary' | 'thread-message' | 'clear' | (string & {});

/** One fully self-describing notification surface. The client renders it with zero composition logic. */
export interface NotificationDescriptor {
  /** Stable id; posting same tag REPLACES (coalesce). {@link AWAY_SUMMARY_TAG} for the summary; unique for
   *  a one-off. This is THE primitive for "replace old popup" (same tag) vs "pop new popup" (unique tag). */
  tag: string;
  /** Template/action discriminator — see {@link NotificationKind}. */
  kind: NotificationKind;
  /** Server-localized title. */
  title: string;
  /** Server-localized body. For an "all"-grouped summary: the folded "X, Y sent you N messages". For a
   *  "thread"-grouped descriptor (one per conversation): "X sent you N messages" (same template, single
   *  sender). Empty for a `clear` descriptor. */
  body: string;
  /** The locale the copy was rendered in (echoes the negotiated Accept-Language). */
  lang: SupportedLocale;
  /** URL to the server-composited stacked-avatar PNG; null → client uses its app icon. */
  icon: string | null;
  /** Re-alert on replace (false = silent update after the first post). Maps to `setOnlyAlertOnce(!renotify)`. */
  renotify: boolean;
  /** Optional attention reason; clients may accent it while still rendering server-authored copy verbatim. */
  attention?: 'mention';
  /** Quiet update (no sound). */
  silent?: boolean;
  /** Buttons — kind-dependent. P1 ships `[]` (actions land in a later phase). */
  actions: NotifAction[];
  /** Routing payload, opaque to the server. The away-summary carries none today — its `dismiss` button is a
   *  pure frontend op (closes the shade, no backend round-trip, no read-watermark change). A future
   *  `single-message` kind would carry one `threadId` + `seq` to identify its message (e.g. for a reply). */
  data: { threadId?: number; seq?: number; [k: string]: unknown };
}
