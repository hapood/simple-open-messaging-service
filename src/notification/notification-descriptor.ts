import type { SupportedLocale } from '../common/locale.js';
import { buildSummaryBody, buildSummaryTitle, actionLabel } from './notif-i18n.js';

/**
 * The notification descriptor — the server-authored presentation + content contract every client renders.
 * Mirrors the Web Notifications API `NotificationOptions` shape so each client maps it 1:1 onto its native
 * notification API (Web `showNotification`, Android `NotificationCompat.Builder`, Tauri bridge), and adds a
 * SOMS-specific `kind` discriminator + routing `data`. This is the single source of truth the three
 * divergent client composers (`sw-push.js` `composeText`, Kotlin `composeAwayText`, `notif-text.ts`
 * `buildAwayBody`) collapse into.
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
export type NotificationKind = 'message-summary' | 'clear' | (string & {});

/** One fully self-describing notification surface. The client renders it with zero composition logic. */
export interface NotificationDescriptor {
  /** Stable id; posting same tag REPLACES (coalesce). {@link AWAY_SUMMARY_TAG} for the summary; unique for
   *  a one-off. This is THE primitive for "replace old popup" (same tag) vs "pop new popup" (unique tag). */
  tag: string;
  /** Template/action discriminator — see {@link NotificationKind}. */
  kind: NotificationKind;
  /** Server-localized title. */
  title: string;
  /** Server-localized body (the folded names + count). Empty for a `clear` descriptor. */
  body: string;
  /** The locale the copy was rendered in (echoes the negotiated Accept-Language). */
  lang: SupportedLocale;
  /** URL to the server-composited stacked-avatar PNG; null → client uses its app icon. */
  icon: string | null;
  /** Re-alert on replace (false = silent update after the first post). Maps to `setOnlyAlertOnce(!renotify)`. */
  renotify: boolean;
  /** Quiet update (no sound). */
  silent?: boolean;
  /** Buttons — kind-dependent. P1 ships `[]` (actions land in a later phase). */
  actions: NotifAction[];
  /** Routing payload, opaque to the server. `message-summary` carries the covered `threadIds` (for a future
   *  mark-all-read action); a future `single-message` would carry one `threadId` + `seq`. */
  data: { threadIds?: number[]; threadId?: number; seq?: number; [k: string]: unknown };
}

/** The input row for the summary composer — a thread's folded display name + unread tally + mute flag.
 *  {@link NotificationQueryService} produces these (its `MissedThreadItem` satisfies this shape); the
 *  composer filters unread+unmuted itself. The sender avatar/userId are NOT here — the icon is composited
 *  separately by `AvatarStackService` (called by the query service) and passed in as `iconUrl`. */
export interface DescriptorItem {
  displayName: string;
  unreadCount: number;
  muted: boolean;
  threadId: number;
}

/** Build the descriptor list for the away-summary from a page of thread items. Returns EXACTLY ONE
 *  descriptor:
 *  - `kind:'clear'` (cancel the tagged notification) when no thread is unread+unmuted;
 *  - `kind:'message-summary'` (the folded body + composited icon) otherwise.
 *
 * `iconUrl` is the pre-composited stacked-avatar URL (or null) — the composer does not composite itself;
 * `NotificationQueryService` calls `AvatarStackService` with the unread+unmuted senders and passes the
 * result here. `renotify` lets the caller quiet updates (e.g. a debounce re-pull mid-burst).
 */
export function composeMessageSummaryDescriptors(
  items: DescriptorItem[],
  opts: { locale: SupportedLocale; iconUrl: string | null; renotify: boolean },
): NotificationDescriptor[] {
  const away = items.filter((i) => i.unreadCount > 0 && !i.muted);
  if (away.length === 0) {
    return [
      {
        tag: AWAY_SUMMARY_TAG,
        kind: 'clear',
        title: '',
        body: '',
        lang: opts.locale,
        icon: null,
        renotify: false,
        actions: [],
        data: {},
      },
    ];
  }
  const body = buildSummaryBody(away, opts.locale);
  const threadIds = away.map((i) => i.threadId);
  return [
    {
      tag: AWAY_SUMMARY_TAG,
      kind: 'message-summary',
      title: buildSummaryTitle(opts.locale),
      body,
      lang: opts.locale,
      icon: opts.iconUrl,
      renotify: opts.renotify,
      // The coalesced summary spans multiple threads, so only a summary-level action applies: mark every
      // covered thread read (the data.threadIds carry them). One action stays within Web Push's 2-action
      // mobile-Chrome cap. Per-thread reply belongs to a future `single-message` kind.
      actions: [{ id: 'mark-all-read', title: actionLabel('mark-all-read', opts.locale) }],
      data: { threadIds },
    },
  ];
}
