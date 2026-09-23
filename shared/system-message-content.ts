import { isProfiledAddress, type ProfiledAddress } from './profiled-address.js';
import {
  parseCallEndedContent,
  type CallEndedContent,
} from './call-ended-content.js';

export type SystemEventAddress = ProfiledAddress;

/** Event participants are independent of the notification sender. */
export type OrdinarySystemMessageContent<A = SystemEventAddress> =
  | { type: 'FRIEND_ADDED'; participants: [A, A] }
  | { type: 'FRIEND_REMOVED'; initiator: A; participants: [A, A] }
  | { type: 'GROUP_CREATED'; creator: A }
  | {
      type:
        | 'GROUP_JOINED'
        | 'GROUP_LEFT'
        | 'GROUP_ADMIN_GRANTED'
        | 'GROUP_ADMIN_REVOKED';
      member: A;
    }
  | { type: 'GROUP_DISSOLVED' }
  | { type: 'GROUP_OWNER_TRANSFERRED'; previousOwner: A; newOwner: A };

export type SystemMessageContent =
  | OrdinarySystemMessageContent
  | CallEndedContent;
export type SystemMessageType = SystemMessageContent['type'];
export const SystemMessageType = {
  CALL_ENDED: 'CALL_ENDED',
  FRIEND_ADDED: 'FRIEND_ADDED',
  FRIEND_REMOVED: 'FRIEND_REMOVED',
  GROUP_CREATED: 'GROUP_CREATED',
  GROUP_JOINED: 'GROUP_JOINED',
  GROUP_LEFT: 'GROUP_LEFT',
  GROUP_DISSOLVED: 'GROUP_DISSOLVED',
  GROUP_ADMIN_GRANTED: 'GROUP_ADMIN_GRANTED',
  GROUP_ADMIN_REVOKED: 'GROUP_ADMIN_REVOKED',
  GROUP_OWNER_TRANSFERRED: 'GROUP_OWNER_TRANSFERRED',
} as const;

export function parseSystemMessageContent(
  value: string,
): SystemMessageContent | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    const body = parsed as Record<string, unknown>;
    if (body['type'] === 'CALL_ENDED') return parseCallEndedContent(value);
    const keys = (...fields: string[]) =>
      Object.keys(body).length === fields.length + 1 &&
      Object.keys(body).every((key) => key === 'type' || fields.includes(key));
    const address = (
      v: unknown,
      allowSystem = false,
    ): v is SystemEventAddress =>
      isProfiledAddress(v) && (v.account !== '$system' || allowSystem);
    const participants = (value: unknown) =>
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((entry) => address(entry));
    let valid = false;
    switch (body['type']) {
      case 'FRIEND_ADDED':
        valid = keys('participants') && participants(body['participants']);
        break;
      case 'FRIEND_REMOVED':
        valid =
          keys('initiator', 'participants') &&
          participants(body['participants']) &&
          address(body['initiator'], true);
        break;
      case 'GROUP_CREATED':
        valid = keys('creator') && address(body['creator']);
        break;
      case 'GROUP_JOINED':
      case 'GROUP_LEFT':
      case 'GROUP_ADMIN_GRANTED':
      case 'GROUP_ADMIN_REVOKED':
        valid = keys('member') && address(body['member']);
        break;
      case 'GROUP_DISSOLVED':
        valid = keys();
        break;
      case 'GROUP_OWNER_TRANSFERRED':
        valid =
          keys('previousOwner', 'newOwner') &&
          address(body['previousOwner']) &&
          address(body['newOwner']);
        break;
    }
    return valid ? (body as unknown as OrdinarySystemMessageContent) : null;
  } catch {
    return null;
  }
}

export function stringifySystemMessageContent(
  body: SystemMessageContent,
): string {
  const content = JSON.stringify(body);
  if (!parseSystemMessageContent(content))
    throw new Error('invalid system message content');
  return content;
}
