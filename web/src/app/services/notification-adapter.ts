import type { NotificationDescriptor } from './notification-descriptor.model';

/** Native notification display and lifecycle. Browser notification projection lives in the database
 * worker and presentation lives in the push service worker; the page only dismisses visible chats. */
export abstract class NotificationAdapter {
  /** Show or update a notification per the client-authored descriptor. `tag` is the replace-by-id primitive
   * (same tag replaces; unique tags stack). */
  abstract showDescriptor(d: NotificationDescriptor): Promise<void>;

  /** Dismiss a card for the chat now open in the foreground, without removing other chats' cards. */
  abstract clearThread(threadId: number): Promise<void>;

  /** Dismiss all cards on explicit session invalidation, never on app exit. */
  abstract clear(): Promise<void>;
}
