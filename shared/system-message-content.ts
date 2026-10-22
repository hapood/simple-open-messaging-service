import { isProfiledAddress, type ProfiledAddress, profileKeyForAddress } from './profiled-address.js';
import {
  parseCallEndedContent,
  type CallEndedContent,
} from './call-ended-content.js';

export type SystemEventAddress = ProfiledAddress;
export { profileKeyForAddress };

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
    ): SystemEventAddress | null =>
      isProfiledAddress(v) && (v.account !== '$system' || allowSystem)
        ? {
            account: v.account,
            publisherNamespaceId: v.publisherNamespaceId,
            profileNamespaceId: v.profileNamespaceId,
            profileRev: v.profileRev,
          }
        : null;
    const participants = (value: unknown): [SystemEventAddress, SystemEventAddress] | null => {
      if (!Array.isArray(value) || value.length !== 2) return null;
      const first = address(value[0]);
      const second = address(value[1]);
      return first && second ? [first, second] : null;
    };
    switch (body['type']) {
      case 'FRIEND_ADDED': {
        if (!keys('participants')) return null;
        const parsedParticipants = participants(body['participants']);
        return parsedParticipants
          ? { type: 'FRIEND_ADDED', participants: parsedParticipants }
          : null;
      }
      case 'FRIEND_REMOVED': {
        if (!keys('initiator', 'participants')) return null;
        const initiator = address(body['initiator'], true);
        const parsedParticipants = participants(body['participants']);
        return initiator && parsedParticipants
          ? {
              type: 'FRIEND_REMOVED',
              initiator,
              participants: parsedParticipants,
            }
          : null;
      }
      case 'GROUP_CREATED': {
        if (!keys('creator')) return null;
        const creator = address(body['creator']);
        return creator ? { type: 'GROUP_CREATED', creator } : null;
      }
      case 'GROUP_JOINED':
      case 'GROUP_LEFT':
      case 'GROUP_ADMIN_GRANTED':
      case 'GROUP_ADMIN_REVOKED': {
        if (!keys('member')) return null;
        const member = address(body['member']);
        return member ? { type: body['type'], member } : null;
      }
      case 'GROUP_DISSOLVED':
        return keys() ? { type: 'GROUP_DISSOLVED' } : null;
      case 'GROUP_OWNER_TRANSFERRED': {
        if (!keys('previousOwner', 'newOwner')) return null;
        const previousOwner = address(body['previousOwner']);
        const newOwner = address(body['newOwner']);
        return previousOwner && newOwner
          ? { type: 'GROUP_OWNER_TRANSFERRED', previousOwner, newOwner }
          : null;
      }
    }
    return null;
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
