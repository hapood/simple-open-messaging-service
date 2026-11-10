import { parseNotificationOpening, type NotificationOpening } from '../../../../shared/notification-opening';

/** Shared, validated Push Service Worker -> page protocol. */
export const SOMS_NOTIF_MSG = {
  ACTIVE_CHAT_REQUEST: 'soms-active-chat-request',
  PRESENTATION_CHANGED: 'soms-notification-presentation-changed',
  PRESENT: 'soms-notification-present',
  RESTORE: 'soms-notification-restore',
  RESET: 'soms-notification-reset',
  OPEN: 'soms-notif-open',
  COMMITTED: 'soms-thread-feed-committed',
} as const;

export type SwNotifMessage =
  | (NotificationOpening & {
      type: typeof SOMS_NOTIF_MSG.OPEN;
      sessionId: number;
    })
  | {
      type: typeof SOMS_NOTIF_MSG.COMMITTED;
      userId: number;
      cursor: number;
      stateCommitted?: boolean;
    };

const coordinate = (value: unknown, minimum: number): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= minimum &&
  value <= 2147483647;

export function parseSwNotifMessage(value: unknown): SwNotifMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  const opening = parseNotificationOpening(message);
  if (
    message['type'] === SOMS_NOTIF_MSG.OPEN &&
    opening &&
    coordinate(message['sessionId'], 1)
  )
    return {
      type: SOMS_NOTIF_MSG.OPEN,
      ...opening,
      sessionId: message['sessionId'],
    };
  if (
    message['type'] === SOMS_NOTIF_MSG.COMMITTED &&
    coordinate(message['userId'], 1) &&
    coordinate(message['cursor'], 0)
  )
    return {
      type: SOMS_NOTIF_MSG.COMMITTED,
      userId: message['userId'],
      cursor: message['cursor'],
      ...(message['stateCommitted'] === true ? { stateCommitted: true } : {}),
    };
  return null;
}
