/** Client-owned presentation model assembled from committed message and request attention. */

/** Sent from the database worker through the page to the push service worker. */
export interface BrowserNotificationBatch {
  userId: number;
  entries: { feedId: number; descriptor: NotificationDescriptor }[];
  /** Account state and thread feeds have independent coordinate spaces. */
  stream?: 'thread' | 'state';
  /** Reconcile an optimistic personal-request read against durable account state. */
  requestReadChanged?: boolean;
  /** Reconcile a local group read or deletion using the durable thread state. */
  groupRequestReadChanged?: number;
  /** Explicit successful full feed-drain signal, including an empty delta. */
  syncComplete?: boolean;
}

export interface NotificationDescriptor {
  /** Presentation kind; navigation uses the separately validated target payload. */
  kind: string;
  title: string;
  body: string;
  /** Unread count represented by this notification. Dismissal never changes its query range. */
  count: number;
  /** The locale used for client-authored notification copy. */
  lang: string;
  /** Client-selected notification icon; null lets the platform use its default. */
  icon: string | null;
  /** Optional attention reason for platform-specific emphasis. */
  attention?: 'mention';
  /** Quiet update (no sound). */
  silent?: boolean;
  /** Read/metadata convergence may update an OS instance but cannot recreate a dismissed card. */
  updateExistingOnly?: boolean;
  messages?: Array<{
    seq: number;
    sender: { account: string; domain: string };
    senderName: string;
    text: string;
    timestamp: number;
  }>;
  previewMode?: 'message' | 'private';
  /** Destination payload; navigation reads only the validated target. */
  data: { target?: unknown; seq?: number; [k: string]: unknown };
}
