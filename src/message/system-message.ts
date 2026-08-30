export const SystemMessageType = {
  FRIEND_ADDED: 'FRIEND_ADDED',
  FRIEND_REMOVED: 'FRIEND_REMOVED',
  GROUP_JOINED: 'GROUP_JOINED',
  GROUP_LEFT: 'GROUP_LEFT',
  GROUP_ADMIN_GRANTED: 'GROUP_ADMIN_GRANTED',
  GROUP_ADMIN_REVOKED: 'GROUP_ADMIN_REVOKED',
  GROUP_OWNER_TRANSFERRED: 'GROUP_OWNER_TRANSFERRED',
  MESSAGE_WITHDRAWN: 'MESSAGE_WITHDRAWN',
  MESSAGES_MODERATED: 'MESSAGES_MODERATED',
  FEDERATION_NAMESPACE_ARCHIVED: 'FEDERATION_NAMESPACE_ARCHIVED',
} as const;

export type SystemMessageType =
  (typeof SystemMessageType)[keyof typeof SystemMessageType];

export interface SystemMessageContent {
  type: SystemMessageType;
  subject?: { account: string; domain: string };
  actor?: { account: string; domain: string };
  count?: number;
  domain?: string;
}

const TYPES = new Set<string>(Object.values(SystemMessageType));

export function parseSystemMessageContent(
  value: string,
): SystemMessageContent | null {
  try {
    const body = JSON.parse(value) as Record<string, unknown>;
    const keys = Object.keys(body);
    const subject = body['subject'] as Record<string, unknown> | undefined;
    const actor = body['actor'] as Record<string, unknown> | undefined;
    const type = String(body['type']);
    const subjectRequired =
      type !== SystemMessageType.FRIEND_ADDED &&
      type !== SystemMessageType.MESSAGES_MODERATED &&
      type !== SystemMessageType.FEDERATION_NAMESPACE_ARCHIVED;
    const countRequired = type === SystemMessageType.MESSAGES_MODERATED;
    const domainRequired =
      type === SystemMessageType.FEDERATION_NAMESPACE_ARCHIVED;
    if (
      keys.some(
        (key) =>
          key !== 'type' &&
          key !== 'subject' &&
          key !== 'actor' &&
          key !== 'count' &&
          key !== 'domain',
      ) ||
      !TYPES.has(type) ||
      (subjectRequired && subject === undefined) ||
      (!subjectRequired && subject !== undefined) ||
      (countRequired &&
        (typeof body['count'] !== 'number' ||
          !Number.isSafeInteger(body['count']) ||
          body['count'] < 1)) ||
      (!countRequired && body['count'] !== undefined) ||
      (domainRequired &&
        (typeof body['domain'] !== 'string' || !body['domain'])) ||
      (!domainRequired && body['domain'] !== undefined) ||
      (subject !== undefined &&
        (typeof subject !== 'object' ||
          Array.isArray(subject) ||
          Object.keys(subject).some(
            (key) => key !== 'account' && key !== 'domain',
          ) ||
          typeof subject['account'] !== 'string' ||
          !subject['account'] ||
          typeof subject['domain'] !== 'string' ||
          !subject['domain'])) ||
      (actor !== undefined &&
        (typeof actor !== 'object' ||
          Array.isArray(actor) ||
          Object.keys(actor).some(
            (key) => key !== 'account' && key !== 'domain',
          ) ||
          typeof actor['account'] !== 'string' ||
          !actor['account'] ||
          typeof actor['domain'] !== 'string' ||
          !actor['domain']))
    ) {
      return null;
    }
    return body as unknown as SystemMessageContent;
  } catch {
    return null;
  }
}

export function stringifySystemMessageContent(
  body: SystemMessageContent,
): string {
  if (!parseSystemMessageContent(JSON.stringify(body)))
    throw new Error('invalid system message content');
  return JSON.stringify(body);
}
