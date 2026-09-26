import {
  parseSystemMessageContent,
  type SystemMessageContent,
} from '../../shared/system-message-content.js';
import type { ProfiledAddress } from '../../shared/profiled-address.js';

export interface CommittedProfileMessage {
  threadId: number;
  threadType: 'P2P' | 'GROUP';
  /** GROUP only: 'local' at the origin, remote domain on a mirror. */
  groupOriginDomain: string | null;
  seq: number;
  profileRev: number;
  creator: { account: string; domain: string; namespaceId: number } | null;
  contentType: string;
  content: string;
  isDeleted: boolean;
  localState: string;
}

export interface MessageProfileProjectionCandidate {
  kind: 'PROJECTION';
  threadId: number;
  messageSeq: number;
  profileRev: number;
  account: string;
  domain: string;
  namespaceId: number;
}

/** A system event can locate participants for prefetch, never select a
 * message-backed projection. eventSeq is internal context, not source evidence. */
export interface SystemEventProfileHint {
  kind: 'PREFETCH';
  lookup:
    | 'RELATIONSHIP_INTENT_PROFILE'
    | 'ACCOUNT_PROFILE'
    | 'GROUP_MEMBER_PROFILE';
  threadId: number;
  eventSeq: number;
  profileRev: number;
  account: string;
  domain: string;
  namespaceId: number;
}

export type CommittedProfileCandidate =
  | MessageProfileProjectionCandidate
  | SystemEventProfileHint;

function eventParticipants(
  content: SystemMessageContent,
  threadType: CommittedProfileMessage['threadType'],
): ProfiledAddress[] {
  if (threadType === 'P2P') {
    switch (content.type) {
      case 'FRIEND_ADDED':
        return content.participants;
      case 'FRIEND_REMOVED':
        return [];
      case 'CALL_ENDED':
        return [content.caller, content.callee];
      default:
        return [];
    }
  }
  switch (content.type) {
    case 'GROUP_CREATED':
      return [content.creator];
    case 'GROUP_JOINED':
    case 'GROUP_ADMIN_GRANTED':
    case 'GROUP_ADMIN_REVOKED':
      return [content.member];
    case 'GROUP_OWNER_TRANSFERRED':
      return [content.previousOwner, content.newOwner];
    case 'GROUP_LEFT':
      return [];
    default:
      return [];
  }
}

/** One pass over committed rows, used by both P2P and group message callers.
 * Callers enforce their own authority before submitting projections or hints.
 * Never order by revision: only a message seq orders projection candidates. */
export function selectCommittedProfileCandidates(
  messages: readonly CommittedProfileMessage[],
): CommittedProfileCandidate[] {
  const projections = new Map<
    number,
    Map<string, MessageProfileProjectionCandidate>
  >();
  const hints = new Map<number, Map<string, SystemEventProfileHint>>();
  for (const item of messages) {
    if (item.isDeleted || item.localState !== 'READY') continue;
    if (item.contentType === 'SYSTEM') {
      const event = parseSystemMessageContent(item.content);
      if (!event) continue;
      for (const address of eventParticipants(event, item.threadType)) {
        if (
          address.profileRev === 0 ||
          address.account === '$system' ||
          address.domain === 'local'
        )
          continue;
        // A local member has their own snapshot. A group origin publishes its
        // member reference itself; only a mirror prefetches remote members
        // from that group's origin after applying the Meta fact.
        if (
          item.threadType === 'GROUP' &&
          (item.groupOriginDomain === null ||
            item.groupOriginDomain === 'local')
        ) {
          continue;
        }
        let thread = hints.get(item.threadId);
        if (!thread) {
          thread = new Map();
          hints.set(item.threadId, thread);
        }
        const key = JSON.stringify([
          address.namespaceId,
          address.account,
          address.domain,
          address.profileRev,
        ]);
        const previous = thread.get(key);
        if (!previous || item.seq > previous.eventSeq) {
          thread.set(key, {
            kind: 'PREFETCH',
            lookup:
              item.threadType === 'GROUP'
                ? 'GROUP_MEMBER_PROFILE'
                : event.type === 'FRIEND_ADDED' ||
                    event.type === 'FRIEND_REMOVED'
                  ? 'RELATIONSHIP_INTENT_PROFILE'
                  : 'ACCOUNT_PROFILE',
            threadId: item.threadId,
            eventSeq: item.seq,
            account: address.account,
            domain: address.domain,
            namespaceId: address.namespaceId,
            profileRev: address.profileRev,
          });
        }
      }
      continue;
    }
    const author = item.creator;
    if (author === null || author.account === '$system') continue;
    let thread = projections.get(item.threadId);
    if (!thread) {
      thread = new Map();
      projections.set(item.threadId, thread);
    }
    const key = JSON.stringify([
      author.namespaceId,
      author.account,
      author.domain,
    ]);
    const previous = thread.get(key);
    if (!previous || item.seq > previous.messageSeq) {
      thread.set(key, {
        kind: 'PROJECTION',
        threadId: item.threadId,
        messageSeq: item.seq,
        profileRev: item.profileRev,
        account: author.account,
        domain: author.domain,
        namespaceId: author.namespaceId,
      });
    }
  }
  return [
    ...[...projections.values()].flatMap((thread) => [...thread.values()]),
    ...[...hints.values()].flatMap((thread) => [...thread.values()]),
  ];
}
