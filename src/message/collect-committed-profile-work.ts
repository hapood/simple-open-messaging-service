import {
  parseSystemMessageContent,
  type SystemMessageContent,
} from '../../shared/system-message-content.js';
import type { ProfiledAddress } from '../../shared/profiled-address.js';
import {
  ProfileLookup,
  type ProfileEvidenceProjection,
  type ProfilePrefetchDemand,
} from '../profile-resolution/profile-resolution-demand.js';

export interface CommittedProfileMessage {
  threadId: number;
  seq: number;
  threadType: 'P2P' | 'GROUP';
  creator: {
    account: string;
    profileNamespaceId: number;
    profileRev: number;
  };
  publisherNamespaceId: number;
  contentType: string;
  content: string;
  isDeleted: boolean;
  localState: string;
  groupAccount?: string;
}

export type MessageProfileProjectionCandidate = {
  demand: ProfilePrefetchDemand;
  evidence: ProfileEvidenceProjection;
};
export type SystemEventProfileHint = ProfilePrefetchDemand;
export interface CommittedProfileWork {
  demands: ProfilePrefetchDemand[];
  evidenceProjections: ProfileEvidenceProjection[];
}

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
export function collectCommittedProfileWork(
  messages: readonly CommittedProfileMessage[],
): CommittedProfileWork {
  const evidenceByThread = new Map<
    number,
    Map<string, MessageProfileProjectionCandidate>
  >();
  const hints = new Map<
    number,
    Map<string, { demand: SystemEventProfileHint; eventSeq: number }>
  >();
  for (const item of messages) {
    if (item.isDeleted || item.localState !== 'READY') continue;
    if (item.contentType === 'SYSTEM') {
      const event = parseSystemMessageContent(item.content);
      if (!event) continue;
      for (const address of eventParticipants(event, item.threadType)) {
        if (
          address.profileRev === 0 ||
          address.account === '$system' ||
          address.profileNamespaceId === 0
        )
          continue;
        // A local publisher already owns the profile snapshot. Remote
        // publishers require a federation profile lookup.
        if (item.publisherNamespaceId === 0) continue;
        let thread = hints.get(item.threadId);
        if (!thread) {
          thread = new Map();
          hints.set(item.threadId, thread);
        }
        const publisherNamespaceId = item.publisherNamespaceId;
        const key = JSON.stringify([
          publisherNamespaceId,
          address.profileNamespaceId,
          address.account,
          address.profileRev,
        ]);
        const previous = thread.get(key);
        if (!previous || item.seq > previous.eventSeq) {
          const target = {
            profileNamespaceId: address.profileNamespaceId,
            account: address.account,
            rev: address.profileRev,
          };
          if (item.threadType === 'GROUP') {
            thread.set(key, {
              demand: {
                publisherNamespaceId,
                lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
                target,
                groupAccount: item.groupAccount!,
              },
              eventSeq: item.seq,
            });
          } else if (
            event.type === 'FRIEND_ADDED' ||
            event.type === 'FRIEND_REMOVED'
          ) {
            thread.set(key, {
              demand: {
                publisherNamespaceId,
                lookup: ProfileLookup.RELATIONSHIP_INTENT_PROFILE,
                target,
                peerAccount: eventParticipants(event, item.threadType).find(
                  (participant) => participant.profileNamespaceId === 0,
                )!.account,
              },
              eventSeq: item.seq,
            });
          } else {
            thread.set(key, {
              demand: {
                publisherNamespaceId,
                lookup: ProfileLookup.ACCOUNT_PROFILE,
                target,
              },
              eventSeq: item.seq,
            });
          }
        }
      }
      continue;
    }
    const author = item.creator;
    if (author.account === '$system') continue;
    let thread = evidenceByThread.get(item.threadId);
    if (!thread) {
      thread = new Map();
      evidenceByThread.set(item.threadId, thread);
    }
    const key = JSON.stringify([
      item.publisherNamespaceId,
      author.profileNamespaceId,
      author.account,
      author.profileNamespaceId,
    ]);
    const previous = thread.get(key);
    if (!previous || item.seq > previous.evidence.projection.messageSeq) {
      const profile = {
        publisherNamespaceId: item.publisherNamespaceId,
        profileNamespaceId: author.profileNamespaceId,
        account: author.account,
        rev: author.profileRev,
      };
      const target = {
        profileNamespaceId: author.profileNamespaceId,
        account: author.account,
        rev: author.profileRev,
      };
      const projection = {
        threadId: item.threadId,
        messageSeq: item.seq,
      };
      thread.set(
        key,
        item.threadType === 'GROUP'
          ? {
              demand: {
                publisherNamespaceId: item.publisherNamespaceId,
                lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
                target,
                groupAccount: item.groupAccount!,
              },
              evidence: {
                profile,
                lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
                groupAccount: item.groupAccount!,
                projection,
              },
            }
          : {
              demand: {
                publisherNamespaceId: item.publisherNamespaceId,
                lookup: ProfileLookup.ACCOUNT_PROFILE,
                target,
              },
              evidence: {
                profile,
                lookup: ProfileLookup.ACCOUNT_PROFILE,
                projection,
              },
            },
      );
    }
  }
  const messageWork = [...evidenceByThread.values()].flatMap((thread) => [
    ...thread.values(),
  ]);
  return {
    demands: [
      ...messageWork.map(({ demand }) => demand),
      ...[...hints.values()].flatMap((thread) =>
        [...thread.values()].map(({ demand }) => demand),
      ),
    ],
    evidenceProjections: messageWork.map(({ evidence }) => evidence),
  };
}
