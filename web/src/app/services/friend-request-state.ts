export type FriendRequestIntentStatus = 'REQUESTED' | 'ACCEPTED' | 'REVOKED';

export type FriendRequestProjectionStatus =
  | 'REQUESTED'
  | 'ACCEPTED'
  | 'REVOKED';

export type FriendRequestBucket = 'RECEIVED' | 'SENT';
export const FRIEND_INTENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface DirectionalFriendIntent {
  status: FriendRequestIntentStatus;
  expiresAt: number | null;
}

export interface FriendRequestPeer {
  id: number;
  account: string;
  name: string;
  avatar: string;
  bio: string;
  domain: string;
  isForeigner: boolean;
}

/** One durable, UI-facing record per relationship pair. Directional state-feed intents are inputs to
 * this projection; request surfaces never read those intents directly. */
export interface FriendRequestProjection {
  key: string;
  kind: 'FRIEND' | 'GROUP';
  /** Stable request-list ownership. Terminal state changes must not move a row between lists. */
  bucket: FriendRequestBucket;
  direction: 'INCOMING' | 'OUTGOING';
  /** Derived presentation/index field. Null means the intent pair must be retained for convergence but
   * has no row in either request list. The authoritative state is local + remote. */
  status: FriendRequestProjectionStatus | null;
  local: DirectionalFriendIntent | null;
  remote: DirectionalFriendIntent | null;
  locallyAccepted: boolean;
  localThreadId: number | null;
  inviteId?: string;
  note: string;
  requestedAt: number;
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
  localThreadId: number | null;
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
  direction?: 'INCOMING' | 'OUTGOING';
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
        bucket: input.direction === 'INCOMING' ? 'RECEIVED' : 'SENT',
        direction: input.direction,
        status: input.status,
        local: null,
        remote: null,
        locallyAccepted: false,
        localThreadId: input.localThreadId ?? null,
        note: input.note,
        requestedAt: input.requestedAt ?? 0,
        peer: input.peer,
        requestedSort: input.requestedAt ?? 0,
        updatedAt: now,
      };
  next.bucket ??= next.direction === 'INCOMING' ? 'RECEIVED' : 'SENT';
  next.updatedAt = now;
  if (input.localThreadId != null) next.localThreadId = input.localThreadId;

  if (input.direction === 'OUTGOING') {
    next.local = {
      status: input.status,
      expiresAt: boundedIntentExpiry(input.requestedAt, input.expiresAt),
    };
  } else {
    next.remote = {
      status: input.status,
      expiresAt: boundedIntentExpiry(input.requestedAt, input.expiresAt),
    };
  }

  // The currently actionable direction owns the card payload and action id.
  if (input.status === 'REQUESTED') {
    next.direction = input.direction;
    next.inviteId = input.inviteId;
    next.note = input.note;
    next.requestedAt = input.requestedAt ?? 0;
    next.requestedSort = input.requestedAt ?? 0;
    next.peer = input.peer;
  }

  const priorActionable =
    current?.direction === 'INCOMING' && current.status === 'REQUESTED';
  const remoteRequested =
    next.remote?.status === 'REQUESTED' &&
    next.remote.expiresAt != null &&
    next.remote.expiresAt > now;
  const localRequested =
    next.local?.status === 'REQUESTED' &&
    next.local.expiresAt != null &&
    next.local.expiresAt > now;

  if (next.local?.status === 'ACCEPTED' && next.remote?.status === 'ACCEPTED') {
    // Received is also the user's request history. Preserve an accepted incoming card in its stable
    // bucket; convergence only makes it non-actionable. A sent-side convergence projection has no
    // received history to preserve and remains unindexed.
    if (next.bucket === 'RECEIVED') {
      next.direction = 'INCOMING';
      next.status = 'ACCEPTED';
      return { record: next, becameActionable: false };
    }
    next.direction = 'OUTGOING';
    next.status = null;
    return { record: next, becameActionable: false };
  }
  if (next.remote?.status === 'REVOKED') {
    // My outgoing request was rejected. Retain the compacted sent-history row in its original bucket.
    if (next.local?.status === 'REQUESTED') {
      next.direction = 'OUTGOING';
      next.bucket = 'SENT';
      next.status = 'REVOKED';
      return { record: next, becameActionable: false };
    }
    if (next.bucket === 'RECEIVED') {
      next.direction = 'INCOMING';
      next.status = 'REVOKED';
    } else next.status = null;
    return { record: next, becameActionable: false };
  }
  if (next.local?.status === 'REVOKED' && next.bucket === 'RECEIVED') {
    next.direction = 'INCOMING';
    next.status = 'REVOKED';
    return { record: next, becameActionable: false };
  }

  if (remoteRequested) {
    next.direction = 'INCOMING';
    next.status =
      next.locallyAccepted || next.local?.status === 'ACCEPTED'
        ? 'ACCEPTED'
        : 'REQUESTED';
  } else if (localRequested) {
    next.direction = 'OUTGOING';
    next.status = next.remote?.status === 'ACCEPTED' ? null : 'REQUESTED';
  } else if (
    next.direction === 'OUTGOING' &&
    next.local?.status === 'REVOKED'
  ) {
    next.status = 'REVOKED';
  } else if (
    next.local?.status === 'ACCEPTED' ||
    next.remote?.status === 'ACCEPTED'
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

/** Client mirror of backend mutuallyAuthorizedSql. REQUESTED grants only while live; both directions
 * must grant and at least one must be the durable ACCEPTED acknowledgement. */
export function friendProjectionIsActive(
  projection: FriendRequestProjection,
  now: number,
): boolean {
  const effective = (
    status: FriendRequestIntentStatus | null,
    expiresAt: number | null | undefined,
  ) =>
    status === 'ACCEPTED' ||
    (status === 'REQUESTED' &&
      typeof expiresAt === 'number' &&
      expiresAt > now);
  return (
    effective(projection.local?.status ?? null, projection.local?.expiresAt) &&
    effective(
      projection.remote?.status ?? null,
      projection.remote?.expiresAt,
    ) &&
    (projection.local?.status === 'ACCEPTED' ||
      projection.remote?.status === 'ACCEPTED')
  );
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
  const direction = input.direction ?? 'INCOMING';
  if (input.status === 'REVOKED' && current) {
    return {
      record: {
        ...current,
        bucket:
          current.bucket ??
          (current.direction === 'INCOMING' ? 'RECEIVED' : 'SENT'),
        status: 'REVOKED',
        local:
          direction === 'OUTGOING'
            ? { status: 'REVOKED', expiresAt: null }
            : current.local,
        remote:
          direction === 'INCOMING'
            ? { status: 'REVOKED', expiresAt: null }
            : current.remote,
        updatedAt: now,
      },
      becameActionable: false,
    };
  }
  if (
    !current &&
    input.status === 'REQUESTED' &&
    (input.expiresAt === null || input.expiresAt <= now)
  )
    return { record: null, becameActionable: false };
  const next: FriendRequestProjection = current
    ? { ...current }
    : {
      key: groupRequestKey(input.domain, input.account),
      kind: 'GROUP',
      bucket: direction === 'INCOMING' ? 'RECEIVED' : 'SENT',
      direction,
      status: null,
      local: null,
      remote: null,
      locallyAccepted: false,
      localThreadId: null,
      inviteId: input.account,
      note: input.note,
      requestedAt: input.requestedAt ?? 0,
      group: input.group,
      sourceLabel: input.group.isLocal ? 'local' : input.group.domain,
      requestedSort: input.requestedAt ?? 0,
      updatedAt: now,
    };
  next.updatedAt = now;
  next.group = input.group;
  next.localThreadId = input.threadId;
  const authored = {
    status: input.status,
    expiresAt: boundedIntentExpiry(input.requestedAt, input.expiresAt),
  };
  if (direction === 'OUTGOING') next.local = authored;
  else next.remote = authored;
  const active = friendProjectionIsActive(next, now);
  if (active) {
    next.status = null;
  } else if (
    input.status === 'REQUESTED' &&
    authored.expiresAt !== null &&
    authored.expiresAt > now
  ) {
    next.direction = direction;
    next.status = direction === 'INCOMING' ? 'REQUESTED' : null;
    next.note = input.note;
    next.requestedAt = input.requestedAt ?? 0;
    next.requestedSort = input.requestedAt ?? 0;
  }
  return {
    record: next,
    becameActionable:
      next.status === 'REQUESTED' && current?.status !== 'REQUESTED',
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
  const intent =
    projection.direction === 'INCOMING' ? projection.remote : projection.local;
  return intent?.status === 'REQUESTED' ? intent.expiresAt : null;
}

function boundedIntentExpiry(
  requestedAt: number | null,
  expiresAt: number | null,
): number | null {
  if (expiresAt === null) return null;
  if (requestedAt === null) return expiresAt;
  return Math.min(expiresAt, requestedAt + FRIEND_INTENT_RETENTION_MS);
}
