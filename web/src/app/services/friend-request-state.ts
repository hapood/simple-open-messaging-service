export type FriendRequestIntentStatus = 'REQUESTED' | 'ACCEPTED' | 'REVOKED';

export type FriendRequestProjectionStatus =
  | 'REQUESTED'
  | 'ACCEPTED'
  | 'REVOKED';

export interface FriendRequestPeer {
  id: number;
  account: string;
  name: string;
  avatar: string;
  domain: string;
  isForeigner: boolean;
}

/** One durable, UI-facing record per relationship pair. Directional state-feed intents are inputs to
 * this projection; request surfaces never read those intents directly. */
export interface FriendRequestProjection {
  key: string;
  kind: 'FRIEND' | 'GROUP';
  direction: 'INCOMING' | 'OUTGOING';
  /** Derived presentation/index field. Null means the intent pair must be retained for convergence but
   * has no row in either request list. The authoritative state is localStatus + remoteStatus. */
  status: FriendRequestProjectionStatus | null;
  localStatus: FriendRequestIntentStatus | null;
  remoteStatus: FriendRequestIntentStatus | null;
  locallyAccepted: boolean;
  inviteId?: string;
  note: string;
  requestedAt: number;
  expiresAt: number | null;
  peer?: FriendRequestPeer;
  group?: {
    account: string;
    domain: string;
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
  account: string;
  domain: string;
  subjectAccount: string;
  subjectDomain: string;
  status: FriendRequestIntentStatus;
  direction: 'INCOMING' | 'OUTGOING';
  inviteId?: string;
  note: string;
  requestedAt: number | null;
  expiresAt: number | null;
  peer: FriendRequestPeer;
}

export interface GroupInviteProjectionInput {
  account: string;
  domain: string;
  status: FriendRequestIntentStatus;
  note: string;
  requestedAt: number | null;
  expiresAt: number | null;
  threadId: number;
  group: NonNullable<FriendRequestProjection['group']>;
}

export function friendPairKey(input: {
  account: string;
  domain: string;
  subjectAccount: string;
  subjectDomain: string;
}): string {
  const endpoints = [
    `${input.domain}\u0000${input.account}`,
    `${input.subjectDomain}\u0000${input.subjectAccount}`,
  ].sort();
  return `friend:${JSON.stringify(endpoints)}`;
}

export function groupRequestKey(domain: string, account: string): string {
  return `group:${domain}\u0000${account}`;
}

export interface ProjectionTransition {
  record: FriendRequestProjection | null;
  becameActionable: boolean;
}

/** Fold one directional intent into the pair projection. A locally accepted request is monotonic: a
 * late/replayed remote REQUESTED fact cannot make it actionable again or recreate an unread badge. */
export function applyFriendIntentToProjection(
  current: FriendRequestProjection | undefined,
  input: FriendIntentProjectionInput,
  now: number,
): ProjectionTransition {
  const key = friendPairKey(input);
  const next: FriendRequestProjection = current
    ? { ...current }
    : {
        key,
        kind: 'FRIEND',
        direction: input.direction,
        status: input.status,
        localStatus: null,
        remoteStatus: null,
        locallyAccepted: false,
        note: input.note,
        requestedAt: input.requestedAt ?? 0,
        expiresAt: input.expiresAt,
        peer: input.peer,
        requestedSort: input.requestedAt ?? 0,
        updatedAt: now,
      };
  next.updatedAt = now;

  if (input.direction === 'OUTGOING') next.localStatus = input.status;
  else next.remoteStatus = input.status;

  // The currently actionable direction owns the card payload and action id.
  if (input.status === 'REQUESTED') {
    next.direction = input.direction;
    next.inviteId = input.inviteId;
    next.note = input.note;
    next.requestedAt = input.requestedAt ?? 0;
    next.requestedSort = input.requestedAt ?? 0;
    next.expiresAt = input.expiresAt;
    next.peer = input.peer;
  }

  const priorActionable =
    current?.direction === 'INCOMING' && current.status === 'REQUESTED';
  const remoteRequested =
    next.remoteStatus === 'REQUESTED' &&
    next.expiresAt !== null &&
    next.expiresAt > now;
  const localRequested =
    next.localStatus === 'REQUESTED' &&
    next.expiresAt !== null &&
    next.expiresAt > now;

  // Both authoritative directions have reached ACCEPTED; the request projection has no remaining job.
  if (next.localStatus === 'ACCEPTED' && next.remoteStatus === 'ACCEPTED')
    return { record: null, becameActionable: false };
  if (next.remoteStatus === 'REVOKED')
    return { record: null, becameActionable: false };

  if (remoteRequested) {
    next.direction = 'INCOMING';
    next.status =
      next.locallyAccepted || next.localStatus === 'ACCEPTED'
        ? 'ACCEPTED'
        : 'REQUESTED';
  } else if (localRequested) {
    next.direction = 'OUTGOING';
    next.status = next.remoteStatus === 'ACCEPTED' ? null : 'REQUESTED';
  } else if (next.direction === 'OUTGOING' && next.localStatus === 'REVOKED') {
    next.status = 'REVOKED';
    next.expiresAt = null;
  } else if (
    next.localStatus === 'ACCEPTED' ||
    next.remoteStatus === 'ACCEPTED'
  ) {
    // One accepted half may arrive before the original request half. The intent pair itself is the
    // state: retain ACCEPTED + null (or its mirror), but leave the derived list status unindexed.
    next.direction = 'OUTGOING';
    next.status = null;
  } else {
    return { record: null, becameActionable: false };
  }

  const actionable =
    next.direction === 'INCOMING' && next.status === 'REQUESTED';
  return {
    record: next,
    becameActionable: actionable && !priorActionable,
  };
}

export function markProjectionAccepted(
  current: FriendRequestProjection,
  now = Date.now(),
): FriendRequestProjection {
  return {
    ...current,
    direction: 'INCOMING',
    status: 'ACCEPTED',
    locallyAccepted: true,
    updatedAt: now,
  };
}

export function applyGroupIntentToProjection(
  current: FriendRequestProjection | undefined,
  input: GroupInviteProjectionInput,
  now: number,
): ProjectionTransition {
  if (
    input.status !== 'REQUESTED' ||
    input.expiresAt === null ||
    input.expiresAt <= now
  )
    return { record: null, becameActionable: false };
  return {
    record: {
      key: groupRequestKey(input.domain, input.account),
      kind: 'GROUP',
      direction: 'INCOMING',
      status: current?.locallyAccepted ? 'ACCEPTED' : 'REQUESTED',
      localStatus: null,
      remoteStatus: 'REQUESTED',
      locallyAccepted: current?.locallyAccepted ?? false,
      inviteId: input.account,
      note: input.note,
      requestedAt: input.requestedAt ?? 0,
      expiresAt: input.expiresAt,
      group: input.group,
      sourceLabel: input.group.isLocal ? 'local' : input.group.domain,
      requestedSort: input.requestedAt ?? 0,
      updatedAt: now,
    },
    becameActionable: current === undefined,
  };
}

export function projectionIsExpired(
  projection: FriendRequestProjection,
  now: number,
): boolean {
  return (
    (projection.expiresAt !== null && projection.expiresAt <= now) ||
    (projection.status === null &&
      projection.updatedAt <= now - 7 * 24 * 60 * 60 * 1000)
  );
}
