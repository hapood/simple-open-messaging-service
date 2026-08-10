export const SystemMessageType = {
  FRIEND_ADDED: 'FRIEND_ADDED',
  FRIEND_REMOVED: 'FRIEND_REMOVED',
  GROUP_JOINED: 'GROUP_JOINED',
  GROUP_LEFT: 'GROUP_LEFT',
  GROUP_ADMIN_GRANTED: 'GROUP_ADMIN_GRANTED',
  GROUP_ADMIN_REVOKED: 'GROUP_ADMIN_REVOKED',
  GROUP_OWNER_TRANSFERRED: 'GROUP_OWNER_TRANSFERRED',
} as const;

export type SystemMessageType =
  (typeof SystemMessageType)[keyof typeof SystemMessageType];

export interface SystemMessageContent {
  type: SystemMessageType;
  subject?: { account: string; domain: string };
}

const TYPES = new Set<string>(Object.values(SystemMessageType));

export function parseSystemMessageContent(
  value: string,
): SystemMessageContent | null {
  try {
    const body = JSON.parse(value) as Record<string, unknown>;
    const keys = Object.keys(body);
    const subject = body['subject'] as Record<string, unknown> | undefined;
    const type = String(body['type']);
    const subjectRequired = type !== SystemMessageType.FRIEND_ADDED;
    if (
      keys.some((key) => key !== 'type' && key !== 'subject') ||
      !TYPES.has(type) ||
      (subjectRequired && subject === undefined) ||
      (!subjectRequired && subject !== undefined) ||
      (subject !== undefined &&
        (typeof subject !== 'object' ||
          Array.isArray(subject) ||
          Object.keys(subject).some(
            (key) => key !== 'account' && key !== 'domain',
          ) ||
          typeof subject['account'] !== 'string' ||
          !subject['account'] ||
          typeof subject['domain'] !== 'string' ||
          !subject['domain']))
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
