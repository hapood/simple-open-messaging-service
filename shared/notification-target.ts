/** Serializable destination shared by notification producers and navigation adapters. */
export type NotificationTarget =
  | { kind: 'thread'; threadId: number }
  | { kind: 'friend-requests' }
  | { kind: 'group-join-requests'; threadId: number };

export function parseNotificationTarget(
  value: unknown,
): NotificationTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = value as { kind?: unknown; threadId?: unknown };
  if (target.kind === 'friend-requests') return { kind: 'friend-requests' };
  if (
    (target.kind === 'thread' || target.kind === 'group-join-requests') &&
    typeof target.threadId === 'number' &&
    Number.isInteger(target.threadId) &&
    target.threadId > 0 &&
    target.threadId <= 2147483647
  )
    return { kind: target.kind, threadId: target.threadId };
  return null;
}

export function notificationTargetKey(target: NotificationTarget): string {
  return target.kind === 'friend-requests'
    ? target.kind
    : `${target.kind}:${target.threadId}`;
}
