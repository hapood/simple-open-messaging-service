export type FriendRequestIntentStatus = 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
export type FriendRequestProjectionStatus = FriendRequestIntentStatus;
export type FriendRequestBucket = 'RECEIVED' | 'SENT';
export type FriendRequestDirection = 'INCOMING' | 'OUTGOING';

export const FRIEND_INTENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface FriendRequestPeer {
  id: number;
  account: string;
  name: string;
  avatar: string;
  bio: string;
  domain: string;
  namespaceId: number;
}

export interface RelationshipIntentFact {
  key: string;
  reverseKey: string;
  status: FriendRequestIntentStatus;
  expiresAt: number | null;
  localThreadId: number | null;
  updatedAt: number;
}

export function relationshipIntentKey(input: {
  namespaceId: number;
  account: string;
  domain: string;
  subjectAccount: string;
  subjectDomain: string;
}): string {
  return `${input.namespaceId}\u0000${input.domain}\u0000${input.account}->${input.subjectDomain}\u0000${input.subjectAccount}`;
}

export function reverseRelationshipIntentKey(input: {
  namespaceId: number;
  account: string;
  domain: string;
  subjectAccount: string;
  subjectDomain: string;
}): string {
  return `${input.namespaceId}\u0000${input.subjectDomain}\u0000${input.subjectAccount}->${input.domain}\u0000${input.account}`;
}

export function relationshipFactsAreActive(
  first: RelationshipIntentFact | undefined,
  second: RelationshipIntentFact | undefined,
  now: number,
): boolean {
  const effective = (fact: RelationshipIntentFact | undefined) =>
    fact?.status === 'ACCEPTED' ||
    (fact?.status === 'REQUESTED' &&
      fact.expiresAt !== null &&
      fact.expiresAt > now);
  return (
    effective(first) &&
    effective(second) &&
    (first?.status === 'ACCEPTED' || second?.status === 'ACCEPTED')
  );
}

/** A disposable UI projection rooted in one authored REQUESTED fact. Relationship authorization
 * is derived from separately persisted intent facts, never from this record. */
export interface FriendRequestProjection {
  key: string;
  namespaceId: number;
  kind: 'FRIEND' | 'GROUP';
  bucket: FriendRequestBucket;
  direction: FriendRequestDirection;
  status: FriendRequestProjectionStatus;
  expiresAt: number;
  localThreadId: number | null;
  inviteId?: string;
  note: string;
  requestedAt: number;
  peer?: FriendRequestPeer;
  group?: {
    account: string;
    domain: string;
    namespaceId: number;
    isLocal: boolean;
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
  namespaceId: number;
  account: string;
  domain: string;
  subjectAccount: string;
  subjectDomain: string;
  status: FriendRequestIntentStatus;
  direction: FriendRequestDirection;
  localThreadId: number | null;
  inviteId?: string;
  note: string;
  requestedAt: number | null;
  expiresAt: number | null;
  peer: FriendRequestPeer;
}

export interface GroupInviteProjectionInput {
  namespaceId: number;
  account: string;
  domain: string;
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
    domain: string;
    subjectAccount: string;
    subjectDomain: string;
    direction: FriendRequestDirection;
  },
  targetDirection: FriendRequestDirection,
): string {
  const sameAuthoredDirection = input.direction === targetDirection;
  const authored = sameAuthoredDirection
    ? `${input.domain}\u0000${input.account}->${input.subjectDomain}\u0000${input.subjectAccount}`
    : `${input.subjectDomain}\u0000${input.subjectAccount}->${input.domain}\u0000${input.account}`;
  return `friend:${input.namespaceId}:${JSON.stringify(authored)}`;
}

export function groupRequestKey(
  namespaceId: number,
  domain: string,
  account: string,
  direction: FriendRequestDirection,
): string {
  return `group:${namespaceId}:${domain}\u0000${account}:${direction}`;
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
    return { record: current ?? null, becameActionable: false };
  if (input.status !== 'REQUESTED')
    return updateLiveProjection(current, input.status, now);

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
    inviteId: input.inviteId,
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
  if (input.status !== 'REQUESTED')
    return updateLiveProjection(current, input.status, now);

  const expiresAt = boundedIntentExpiry(input.requestedAt, input.expiresAt);
  if (expiresAt === null || expiresAt <= now)
    return { record: current ?? null, becameActionable: false };
  const record: FriendRequestProjection = {
    key: groupRequestKey(
      input.namespaceId,
      input.domain,
      input.account,
      direction,
    ),
    namespaceId: input.namespaceId,
    kind: 'GROUP',
    bucket: direction === 'INCOMING' ? 'RECEIVED' : 'SENT',
    direction,
    status: 'REQUESTED',
    expiresAt,
    localThreadId: input.threadId,
    inviteId: input.account,
    note: input.note,
    requestedAt: input.requestedAt ?? 0,
    group: input.group,
    sourceLabel: input.group.isLocal ? 'local' : input.group.domain,
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
  status: Exclude<FriendRequestIntentStatus, 'REQUESTED'>,
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
