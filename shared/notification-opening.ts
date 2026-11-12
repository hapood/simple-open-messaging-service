import { parseNotificationTarget, type NotificationTarget } from './notification-target';

/** A message card carries a refresh ceiling, independently of its stable card identity. */
export type NotificationOpening =
  | { target: Extract<NotificationTarget, { kind: 'thread' }>; latestSeq: number }
  | { target: Exclude<NotificationTarget, { kind: 'thread' }>; latestSeq?: never };

export function parseNotificationOpening(value: unknown): NotificationOpening | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as { target?: unknown; latestSeq?: unknown };
  const target = parseNotificationTarget(data.target);
  if (!target) return null;
  if (target.kind !== 'thread') return { target };
  if (typeof data.latestSeq !== 'number' || !Number.isSafeInteger(data.latestSeq) || data.latestSeq < 0 || data.latestSeq > 2147483647) return null;
  return { target, latestSeq: data.latestSeq };
}
