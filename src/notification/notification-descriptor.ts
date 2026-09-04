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
 * `/notification-feed/query` and renders the descriptor(s) verbatim. The backend decides both WHAT the
 * notification shows (title/body/icon, server-localized) AND how it behaves relative to an existing one
 * (`tag` = replace-in-place vs new; `kind` = template + action set; `actions` = buttons).
 */

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
 * The message surface ships one per-conversation kind today:
 *  - `'thread-message'`  — one stable notification per conversation.
 * Future kinds (`'single-message'` with a per-thread reply action, `'friend-request'`, …) extend this union.
 */
export type NotificationKind = 'thread-message' | (string & {});

export interface NotificationMessage {
  seq: number;
  sender: { account: string; domain: string };
  senderName: string;
  text: string;
  timestamp: number;
}

/** One fully self-describing notification surface. The client renders it with zero composition logic. */
export interface NotificationDescriptor {
  /** Stable id; posting the same per-thread tag replaces that conversation's prior notification. */
  tag: string;
  /** Template/action discriminator — see {@link NotificationKind}. */
  kind: NotificationKind;
  /** Server-localized title. */
  title: string;
  /** Server-localized body for one conversation, such as "X sent you N messages". */
  body: string;
  /** Number of new messages represented by this notification, measured from the client's frozen foreground
   *  HWM (or its later per-thread dismiss HWM). Android feeds this directly to `Notification.setNumber`, so
   *  the launcher badge and notification copy share one server-authored count. */
  count: number;
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
  /** Present only in message-preview mode. Private mode deliberately omits this field. */
  messages?: NotificationMessage[];
  previewMode?: 'message' | 'private';
  /** Routing payload. Message descriptors carry `threadId` + `seq`. */
  data: { threadId?: number; seq?: number; [k: string]: unknown };
}
