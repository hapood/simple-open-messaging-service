/** Shared, validated Push Service Worker -> page protocol. */
export const SOMS_NOTIF_MSG = {
  ACTIVE_CHAT_REQUEST: 'soms-active-chat-request',
  PRESENT: 'soms-notification-present',
  OPEN: 'soms-notif-open',
  COMMITTED: 'soms-thread-feed-committed',
} as const;

export type SwNotifMessage =
  | { type: typeof SOMS_NOTIF_MSG.OPEN; threadId: number }
  | { type: typeof SOMS_NOTIF_MSG.COMMITTED; userId: number; cursor: number };

const coordinate = (value: unknown, minimum: number): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= minimum &&
  value <= 2147483647;

export function parseSwNotifMessage(value: unknown): SwNotifMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (
    message['type'] === SOMS_NOTIF_MSG.OPEN &&
    coordinate(message['threadId'], 1)
  )
    return { type: SOMS_NOTIF_MSG.OPEN, threadId: message['threadId'] };
  if (
    message['type'] === SOMS_NOTIF_MSG.COMMITTED &&
    coordinate(message['userId'], 1) &&
    coordinate(message['cursor'], 0)
  )
    return {
      type: SOMS_NOTIF_MSG.COMMITTED,
      userId: message['userId'],
      cursor: message['cursor'],
    };
  return null;
}
