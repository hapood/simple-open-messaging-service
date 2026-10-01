import { normalizeAccount } from '../common/account.js';
import type { Message } from '../message/message.service.js';
import {
  ProfileLookup,
  type ProfileEvidenceProjection,
  type ProfilePrefetchDemand,
} from '../profile-resolution/profile-resolution-demand.js';
import type { FederationThreadAddress } from './federation-message-feed.service.js';

/** Select snapshot-only profile work from a committed inbound federation message. */
export function selectInboundMessageProfileDemand(
  thread: FederationThreadAddress,
  message: Message,
  publisherNamespaceId: number,
  profileNamespaceId: number,
): ProfilePrefetchDemand | undefined {
  const profile = inboundMessageProfileWorkSubject(
    message,
    publisherNamespaceId,
    profileNamespaceId,
  );
  if (!profile) return undefined;
  return thread.account.startsWith('!')
    ? {
        publisherNamespaceId,
        lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
        target: profile.target,
        groupAccount: normalizeAccount(thread.account),
      }
    : {
        publisherNamespaceId,
        lookup: ProfileLookup.ACCOUNT_PROFILE,
        target: profile.target,
      };
}

export function selectInboundMessageProfileEvidenceProjection(
  thread: FederationThreadAddress,
  message: Message,
  publisherNamespaceId: number,
  profileNamespaceId: number,
): ProfileEvidenceProjection | undefined {
  const profile = inboundMessageProfileWorkSubject(
    message,
    publisherNamespaceId,
    profileNamespaceId,
  );
  if (!profile) return undefined;
  const projection = { threadId: message.threadId, messageSeq: message.seq };
  return thread.account.startsWith('!')
    ? {
        profile: profile.key,
        lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
        groupAccount: normalizeAccount(thread.account),
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
  publisherNamespaceId: number,
  profileNamespaceId: number,
):
  | {
      target: {
        profileNamespaceId: number;
        account: string;
        rev: number;
      };
      key: {
        publisherNamespaceId: number;
        profileNamespaceId: number;
        account: string;
        rev: number;
      };
    }
  | undefined {
  if (
    publisherNamespaceId === 0 ||
    message.isDeleted ||
    message.profileRev < 1 ||
    message.creatorAccount === null
  )
    return undefined;

  const target = {
    profileNamespaceId,
    account: message.creatorAccount,
    rev: message.profileRev,
  };
  return { target, key: { publisherNamespaceId, ...target } };
}
