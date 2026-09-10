/** Client-owned presentation model assembled from committed thread-feed projections. */

export interface NotificationDescriptor {
  /** Stable per-thread id; posting the same tag replaces that conversation's prior notification. */
  tag: string;
  /** Template/action discriminator: `'thread-message'` today; extensible for future notification kinds. */
  kind: string;
  title: string;
  body: string;
  /** Unread count represented by this notification. Dismissal never changes its query range. */
  count: number;
  /** The locale used for client-authored notification copy. */
  lang: string;
  /** Client-selected notification icon; null lets the platform use its default. */
  icon: string | null;
  /** Re-alert on replace (false = silent update after the first post). */
  renotify: boolean;
  /** Optional attention reason for platform-specific emphasis. */
  attention?: 'mention';
  /** Quiet update (no sound). */
  silent?: boolean;
  messages?: Array<{
    seq: number;
    sender: { account: string; domain: string };
    senderName: string;
    text: string;
    timestamp: number;
  }>;
  previewMode?: 'message' | 'private';
  /** Routing payload for opening a per-thread notification. */
  data: { threadId?: number; seq?: number; [k: string]: unknown };
}
