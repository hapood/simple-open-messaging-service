import { parseRequestSnapshot, type RequestSnapshot } from '../../../../shared/request-snapshot';
import type { RequestRevocationStatus } from '../../../../shared/request-projection-status';
import {
  RequestProjectionStatus,
  type RequestProjectionStatusValue,
} from '../../../../shared/request-projection-status';
export type FriendRequestIntentStatus = 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
type FriendRequestProjectionStatus = RequestProjectionStatusValue;
type FriendRequestBucket = 'RECEIVED' | 'SENT';
export type FriendRequestDirection = 'INCOMING' | 'OUTGOING';

export const FRIEND_INTENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface FriendRequestPeer {
  id: number;
  account: string;
  avatar: string;
  bio: string;
  namespaceId: number;
  profileRev?: number;
}

/** A disposable UI projection rooted in one authored REQUESTED fact. Conversation state
 * comes from the thread feed, never from this request record. */
export interface FriendRequestProjection {
  key: string;
  namespaceId: number;
  kind: 'FRIEND' | 'GROUP';
  bucket: FriendRequestBucket;
  direction: FriendRequestDirection;
  status: FriendRequestProjectionStatus;
  expiresAt: number;
  localThreadId: number | null;
  note: string;
  requestedAt: number;
  peer?: FriendRequestPeer;
  group?: {
    account: string;
    namespaceId: number;
    profileRev: number;
  };
  sourceLabel?: string;
  /** Present only for send-time receiver presentation; suppresses profile resolution. */
  snapshot: RequestSnapshot | null;
  requestedSort: number;
  updatedAt: number;
  sourceFeedId: number;
}

export interface FriendIntentProjectionInput {
  feedId: number;
  requestStatus?: RequestRevocationStatus;
  requestDirection?: FriendRequestDirection;
  namespaceId: number;
  account: string;
  subjectAccount: string;
  subjectNamespaceId: number;
  status: FriendRequestIntentStatus;
  direction: FriendRequestDirection;
  localThreadId: number | null;
  note: string;
  requestedAt: number | null;
  expiresAt: number | null;
  peer: FriendRequestPeer;
  snapshot: unknown;
}

export interface GroupInviteProjectionInput {
  feedId: number;
  requestStatus?: RequestRevocationStatus;
  requestDirection?: FriendRequestDirection;
  namespaceId: number;
  status: FriendRequestIntentStatus;
  note: string;
  requestedAt: number | null;
  expiresAt: number | null;
  direction?: FriendRequestDirection;
  threadId: number;
  group: NonNullable<FriendRequestProjection['group']>;
  snapshot: unknown;
}

export function projectionDirectionForFact(input: {
  status: FriendRequestIntentStatus;
  direction: FriendRequestDirection;
}): FriendRequestDirection | null {
  if (input.status === 'ACCEPTED')
    return input.direction === 'INCOMING' ? 'OUTGOING' : null;
  return input.direction;
}

/** Canonical projection key for one friend-intent pair direction.
 *
 * Client state feed recipients are always namespace-0 local accounts, so a
 * RELATIONSHIP_INTENT item never carries the author's home namespace
 * directly: its namespaceId is the pair namespace (the remote peer's home
 * namespace) and subjectNamespaceId is the subject endpoint's home namespace.
 * The author's home namespace is therefore the item namespaceId when the
 * subject is the local user, and 0 when the subject is the remote peer. This
 * keeps a self-authored send echo and the peer-authored terminal fact
 * (accept/reject) on one key for federated pairs; local pairs collapse to
 * all-zero namespace slots either way. */
export function friendRequestKey(
  input: {
    namespaceId: number;
    account: string;
    subjectAccount: string;
    subjectNamespaceId: number;
    direction: FriendRequestDirection;
  },
  targetDirection: FriendRequestDirection,
): string {
  const authorNamespaceId =
    input.subjectNamespaceId === 0 ? input.namespaceId : 0;
  const sameAuthoredDirection = input.direction === targetDirection;
  return JSON.stringify(
    sameAuthoredDirection
      ? [
          'friend',
          authorNamespaceId,
          input.account,
          input.subjectNamespaceId,
          input.subjectAccount,
        ]
      : [
          'friend',
          input.subjectNamespaceId,
          input.subjectAccount,
          authorNamespaceId,
          input.account,
        ],
  );
}

export function groupRequestKey(
  namespaceId: number,
  account: string,
  direction: FriendRequestDirection,
): string {
  return JSON.stringify(['group', namespaceId, account, direction]);
}

export interface ProjectionTransition {
  record: FriendRequestProjection | null;
  becameActionable: boolean;
}

export function applyFriendIntentToProjection(
  current: FriendRequestProjection | undefined,
  input: FriendIntentProjectionInput,
  now: number,
): ProjectionTransition {
  if (current && input.feedId <= current.sourceFeedId)
    return { record: current, becameActionable: false };
  if (input.status === 'ACCEPTED' && input.direction === 'OUTGOING')
    return current
      ? updateLiveProjection(current, 'ACCEPTED', now, input.feedId)
      : { record: null, becameActionable: false };
  if (input.status === 'REVOKED' && !input.requestStatus)
    return { record: current ?? null, becameActionable: false };
  if (input.status !== 'REQUESTED')
    return updateLiveProjection(
      current,
      input.status === 'REVOKED'
        ? input.requestStatus!
        : RequestProjectionStatus.ACCEPTED,
      now,
      input.feedId,
    );

  const expiresAt = boundedIntentExpiry(input.requestedAt, input.expiresAt);
  if (expiresAt === null || expiresAt <= now)
    return { record: current ?? null, becameActionable: false };
  const record: FriendRequestProjection = {
    key: friendRequestKey(input, input.direction),
    namespaceId: input.namespaceId,
    kind: 'FRIEND',
    bucket: input.direction === 'INCOMING' ? 'RECEIVED' : 'SENT',
    direction: input.direction,
    status: 'REQUESTED',
    expiresAt,
    localThreadId: input.localThreadId,
    note: input.note,
    requestedAt: input.requestedAt ?? 0,
    peer: input.peer,
    snapshot: input.direction === 'OUTGOING' ? parseRequestSnapshot(input.snapshot) : null,
    requestedSort: input.requestedAt ?? 0,
    updatedAt: now,
    sourceFeedId: input.feedId,
  };
  return {
    record,
    becameActionable:
      input.direction === 'INCOMING' &&
      (current?.status !== 'REQUESTED' || current.expiresAt <= now),
  };
}

/** Persist the request-card side effect of a successful local accept action. The authored local ACK
 * remains an intent fact and is deliberately a projection no-op when it later arrives via the feed. */
export function markProjectionAccepted(
  current: FriendRequestProjection,
  now = Date.now(),
  sourceFeedId?: number,
): FriendRequestProjection {
  return (
    updateLiveProjection(current, 'ACCEPTED', now, sourceFeedId).record ??
    current
  );
}

export function applyGroupIntentToProjection(
  current: FriendRequestProjection | undefined,
  input: GroupInviteProjectionInput,
  now: number,
): ProjectionTransition {
  const direction = input.direction ?? 'INCOMING';
  if (current && input.feedId <= current.sourceFeedId)
    return { record: current, becameActionable: false };
  if (input.status === 'ACCEPTED' && direction === 'OUTGOING')
    return { record: current ?? null, becameActionable: false };
  if (input.status === 'REVOKED' && !input.requestStatus)
    return { record: current ?? null, becameActionable: false };
  if (input.status !== 'REQUESTED')
    return updateLiveProjection(
      current,
      input.status === 'REVOKED'
        ? input.requestStatus!
        : RequestProjectionStatus.ACCEPTED,
      now,
      input.feedId,
    );

  const expiresAt = boundedIntentExpiry(input.requestedAt, input.expiresAt);
  if (expiresAt === null || expiresAt <= now)
    return { record: current ?? null, becameActionable: false };
  const record: FriendRequestProjection = {
    key: groupRequestKey(input.namespaceId, input.group.account, direction),
    namespaceId: input.namespaceId,
    kind: 'GROUP',
    bucket: direction === 'INCOMING' ? 'RECEIVED' : 'SENT',
    direction,
    status: 'REQUESTED',
    expiresAt,
    localThreadId: input.threadId,
    note: input.note,
    requestedAt: input.requestedAt ?? 0,
    group: input.group,
    sourceLabel: input.group.namespaceId === 0 ? 'local' : '',
    snapshot: direction === 'OUTGOING' ? parseRequestSnapshot(input.snapshot) : null,
    requestedSort: input.requestedAt ?? 0,
    updatedAt: now,
    sourceFeedId: input.feedId,
  };
  return {
    record,
    becameActionable:
      direction === 'INCOMING' &&
      (current?.status !== 'REQUESTED' || current.expiresAt <= now),
  };
}

function updateLiveProjection(
  current: FriendRequestProjection | undefined,
  status: Exclude<RequestProjectionStatusValue, 'REQUESTED'>,
  now: number,
  sourceFeedId?: number,
): ProjectionTransition {
  if (!current || current.status !== 'REQUESTED' || current.expiresAt <= now)
    return { record: current ?? null, becameActionable: false };
  return {
    record: {
      ...current,
      status,
      updatedAt: now,
      ...(sourceFeedId === undefined ? {} : { sourceFeedId }),
    },
    becameActionable: false,
  };
}

export function projectionIsExpired(
  projection: FriendRequestProjection,
  now: number,
): boolean {
  return projection.updatedAt <= now - FRIEND_INTENT_RETENTION_MS;
}

export function projectionRequestExpiresAt(
  projection: FriendRequestProjection,
): number | null {
  return projection.status === 'REQUESTED' ? projection.expiresAt : null;
}

function boundedIntentExpiry(
  requestedAt: number | null,
  expiresAt: number | null,
): number | null {
  if (expiresAt === null) return null;
  if (requestedAt === null) return expiresAt;
  return Math.min(expiresAt, requestedAt + FRIEND_INTENT_RETENTION_MS);
}
