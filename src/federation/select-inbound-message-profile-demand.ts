import { normalizeAccount } from '../common/account.js';
import type { Message } from '../message/message.service.js';
import {
  ProfileLookup,
  type ProfileEvidenceProjection,
  type ProfilePrefetchDemand,
} from '../profile-resolution/profile-resolution-demand.js';
import type { FederationMessageFeedMessage } from './federation-message-feed.service.js';

/** Select snapshot-only profile work from a committed inbound federation message. */
export function selectInboundMessageProfileDemand(
  item: FederationMessageFeedMessage,
  message: Message,
  namespaceId: number,
): ProfilePrefetchDemand | undefined {
  const profile = inboundMessageProfileWorkSubject(message, namespaceId);
  if (!profile) return undefined;
  return item.thread.account.startsWith('!')
    ? {
        namespaceId,
        lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
        target: profile.target,
        groupAccount: normalizeAccount(item.thread.account),
      }
    : {
        namespaceId,
        lookup: ProfileLookup.ACCOUNT_PROFILE,
        target: profile.target,
      };
}

export function selectInboundMessageProfileEvidenceProjection(
  item: FederationMessageFeedMessage,
  message: Message,
  namespaceId: number,
): ProfileEvidenceProjection | undefined {
  const profile = inboundMessageProfileWorkSubject(message, namespaceId);
  if (!profile) return undefined;
  const projection = { threadId: message.threadId, messageSeq: message.seq };
  return item.thread.account.startsWith('!')
    ? {
        profile: profile.key,
        lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
        groupAccount: normalizeAccount(item.thread.account),
        projection,
      }
    : {
        profile: profile.key,
        lookup: ProfileLookup.ACCOUNT_PROFILE,
        projection,
      };
}

function inboundMessageProfileWorkSubject(
  message: Message,
  namespaceId: number,
):
  | {
      target: { account: string; domain: string; rev: number };
      key: { namespaceId: number; account: string; domain: string; rev: number };
    }
  | undefined {
  if (
    namespaceId === 0 ||
    message.isDeleted ||
    message.profileRev < 1 ||
    message.creatorAccount === null ||
    message.creatorDomain === null ||
    message.creatorDomain === 'local'
  )
    return undefined;

  const target = {
    account: message.creatorAccount,
    domain: message.creatorDomain,
    rev: message.profileRev,
  };
  return { target, key: { namespaceId, ...target } };
}
