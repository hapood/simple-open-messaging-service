import {
  parseNotificationTarget,
  notificationTargetKey,
  type NotificationTarget,
} from '../../../../shared/notification-target';

/** Targets are the only navigation contract; there is no flattened fallback. */
export function notificationTarget(
  data: { target?: unknown } | null | undefined,
): NotificationTarget | null {
  return parseNotificationTarget(data?.target);
}

export function notificationKey(
  data: { target?: unknown } | null | undefined,
): string | null {
  const target = notificationTarget(data);
  return target ? notificationTargetKey(target) : null;
}

export function notificationClickUrl(
  target: NotificationTarget,
  sessionId: number,
): string {
  if (target.kind === 'thread')
    return `/chat/${target.threadId}?notificationSessionId=${sessionId}`;
  return (
    `/?notificationSessionId=${sessionId}&notificationTarget=${target.kind}` +
    (target.kind === 'group-join-requests'
      ? `&threadId=${target.threadId}`
      : '')
  );
}

export function isActiveMessage(
  data: { target?: unknown },
  activeChat?: number,
): boolean {
  const target = notificationTarget(data);
  return target?.kind === 'thread' && target.threadId === activeChat;
}
