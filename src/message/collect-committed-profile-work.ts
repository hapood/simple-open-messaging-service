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

interface CommittedProfileMessageBase {
  threadId: number;
  seq: number;
  profileRev: number;
  creator: { account: string; domain: string; namespaceId: number };
  contentType: string;
  content: string;
  isDeleted: boolean;
  localState: string;
}

export type CommittedProfileMessage =
  | (CommittedProfileMessageBase & {
      threadType: 'P2P';
    })
  | (CommittedProfileMessageBase & {
      threadType: 'GROUP';
      groupAccount: string;
      /** 'local' at the origin, remote domain on a mirror. */
      groupOriginDomain: string;
    });

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
          address.domain === 'local'
        )
          continue;
        // A local member has their own snapshot. A group origin publishes its
        // member reference itself; only a mirror prefetches remote members
        // from that group's origin after applying the Meta fact.
        if (item.threadType === 'GROUP' && item.groupOriginDomain === 'local') {
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
          if (item.threadType === 'GROUP') {
            thread.set(key, {
              demand: {
                namespaceId: address.namespaceId,
                lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
                target: {
                  account: address.account,
                  domain: address.domain,
                  rev: address.profileRev,
                },
                groupAccount: item.groupAccount,
              },
              eventSeq: item.seq,
            });
          } else if (
            event.type === 'FRIEND_ADDED' ||
            event.type === 'FRIEND_REMOVED'
          ) {
            thread.set(key, {
              demand: {
                namespaceId: address.namespaceId,
                lookup: ProfileLookup.RELATIONSHIP_INTENT_PROFILE,
                target: {
                  account: address.account,
                  domain: address.domain,
                  rev: address.profileRev,
                },
                peerAccount: eventParticipants(event, item.threadType).find(
                  (participant) => participant.domain === 'local',
                )!.account,
              },
              eventSeq: item.seq,
            });
          } else {
            thread.set(key, {
              demand: {
                namespaceId: address.namespaceId,
                lookup: ProfileLookup.ACCOUNT_PROFILE,
                target: {
                  account: address.account,
                  domain: address.domain,
                  rev: address.profileRev,
                },
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
      author.namespaceId,
      author.account,
      author.domain,
    ]);
    const previous = thread.get(key);
    if (!previous || item.seq > previous.evidence.projection.messageSeq) {
      const profile = {
        namespaceId: author.namespaceId,
        account: author.account,
        domain: author.domain,
        rev: item.profileRev,
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
                namespaceId: author.namespaceId,
                lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
                target: {
                  account: author.account,
                  domain: author.domain,
                  rev: item.profileRev,
                },
                groupAccount: item.groupAccount,
              },
              evidence: {
                profile,
                lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
                groupAccount: item.groupAccount,
                projection,
              },
            }
          : {
              demand: {
                namespaceId: author.namespaceId,
                lookup: ProfileLookup.ACCOUNT_PROFILE,
                target: {
                  account: author.account,
                  domain: author.domain,
                  rev: item.profileRev,
                },
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
  const messageWork = [...evidenceByThread.values()].flatMap((thread) =>
    [...thread.values()],
  );
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
