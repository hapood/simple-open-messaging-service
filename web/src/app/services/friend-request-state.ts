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
  name: string;
  avatar: string;
  bio: string;
  domain: string;
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
    name: string;
    avatar: string;
    description: string;
    profileRev: number;
  };
  sourceLabel?: string;
  requestedSort: number;
  updatedAt: number;
}

export interface FriendIntentProjectionInput {
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
}

export interface GroupInviteProjectionInput {
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
}

export function projectionDirectionForFact(input: {
  status: FriendRequestIntentStatus;
  direction: FriendRequestDirection;
}): FriendRequestDirection | null {
  if (input.status === 'ACCEPTED')
    return input.direction === 'INCOMING' ? 'OUTGOING' : null;
  return input.direction;
}

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
  const sameAuthoredDirection = input.direction === targetDirection;
  return JSON.stringify(
    sameAuthoredDirection
      ? [
          'friend',
          input.namespaceId,
          input.account,
          input.subjectNamespaceId,
          input.subjectAccount,
        ]
      : [
          'friend',
          input.subjectNamespaceId,
          input.subjectAccount,
          input.namespaceId,
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
  if (input.status === 'ACCEPTED' && input.direction === 'OUTGOING')
    return current
      ? updateLiveProjection(current, 'ACCEPTED', now)
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
    requestedSort: input.requestedAt ?? 0,
    updatedAt: now,
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
): FriendRequestProjection {
  return updateLiveProjection(current, 'ACCEPTED', now).record ?? current;
}

export function applyGroupIntentToProjection(
  current: FriendRequestProjection | undefined,
  input: GroupInviteProjectionInput,
  now: number,
): ProjectionTransition {
  const direction = input.direction ?? 'INCOMING';
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
    );

  const expiresAt = boundedIntentExpiry(input.requestedAt, input.expiresAt);
  if (expiresAt === null || expiresAt <= now)
    return { record: current ?? null, becameActionable: false };
  const record: FriendRequestProjection = {
    key: groupRequestKey(
      input.namespaceId,
      input.group.account,
      direction,
    ),
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
    requestedSort: input.requestedAt ?? 0,
    updatedAt: now,
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
): ProjectionTransition {
  if (!current || current.status !== 'REQUESTED' || current.expiresAt <= now)
    return { record: current ?? null, becameActionable: false };
  return {
    record: { ...current, status, updatedAt: now },
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
