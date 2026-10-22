import { normalizeAccount } from '../common/account.js';
import {
  ProfileLookup,
  type ProfileEvidenceProjection,
  type ProfilePrefetchDemand,
} from '../profile-resolution/profile-resolution-demand.js';
import type { FederationThreadAddress } from './federation-message-feed.service.js';

/** The message fields profile work is derived from. A committed media STUB
 * supplies the same evidence as a READY row, so callers may pass either the
 * stored row or the admitted stub coordinate in this structural shape. */
export interface InboundProfileWorkMessage {
  threadId: number;
  seq: number;
  isDeleted: boolean;
  profileRev: number;
  creatorAccount: string | null;
}

/** Select snapshot-only profile work from a committed inbound federation message. */
export function selectInboundMessageProfileDemand(
  thread: FederationThreadAddress,
  message: InboundProfileWorkMessage,
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
  message: InboundProfileWorkMessage,
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
  message: InboundProfileWorkMessage,
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
