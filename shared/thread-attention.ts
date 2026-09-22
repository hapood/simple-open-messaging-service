/** One atomic server snapshot. Its account-scoped feed ID also orders visible thread-list items. */
export interface ThreadFeedSnapshot {
  threadId: number;
  threadFeedId: number;
  /** Private label owned by this account. Null restores the canonical name. */
  alias: string | null;
  threadProfileRev: number;
  messageEndSeq: number;
  tombstoneEndSeq: number;
  /** Canonical Group Meta coordinate; null for P2P threads. */
  groupMetaFeedEndId: string | null;
  /** Latest join-application projection coordinate for this manager. */
  joinRequestEndFeedId: number;
  /** -1 for non-managers; otherwise the consumed join-application coordinate. */
  joinRequestReadFeedId: number;
  /** Latest group-invitation projection coordinate for this manager. */
  groupInviteEndFeedId: number;
  lastReadSeq: number;
  unreadCount: number;
  lastMentionSeq: number | null;
  previews?: Array<{
    seq: number;
    createdAt: string;
    sender: { account: string; domain: string } | null;
    status: 'LIVE' | 'USER_RETRACTION' | 'MODERATION_REMOVAL';
    text?: string;
  }>;
}

/** Display reconciliation state; read submissions have their own lifecycle. */
export interface LocalThreadAttention {
  threadId: number;
  server: ThreadFeedSnapshot | null;
  localReadSeq: number | null;
}

const INT32_MAX = 2_147_483_647;

function coordinate(value: number, name: string, minimum = 0): void {
  if (!Number.isInteger(value) || value < minimum || value > INT32_MAX)
    throw new Error(`Invalid attention ${name}`);
}

export function createLocalThreadAttention(
  threadId: number,
): LocalThreadAttention {
  coordinate(threadId, 'threadId', 1);
  return { threadId, server: null, localReadSeq: null };
}

/** Never replace an established display position with a remote read position. */
export function mergeThreadAttention(
  current: LocalThreadAttention,
  incoming: ThreadFeedSnapshot,
): LocalThreadAttention {
  if (incoming.alias !== null && typeof incoming.alias !== 'string')
    throw new Error('Invalid thread alias');
  coordinate(incoming.threadId, 'threadId', 1);
  coordinate(incoming.threadFeedId, 'feed ID');
  coordinate(incoming.threadProfileRev, 'profile revision');
  coordinate(incoming.messageEndSeq, 'message end');
  coordinate(incoming.tombstoneEndSeq, 'tombstone end');
  coordinate(incoming.joinRequestEndFeedId, 'join request end');
  coordinate(incoming.joinRequestReadFeedId, 'join request read', -1);
  coordinate(incoming.groupInviteEndFeedId, 'group invite end');
  if (incoming.joinRequestReadFeedId > incoming.joinRequestEndFeedId)
    throw new Error('Invalid attention join request read position');
  if (
    incoming.groupMetaFeedEndId !== null &&
    !/^(0|[1-9]\d*)$/.test(incoming.groupMetaFeedEndId)
  )
    throw new Error('Invalid attention Group Meta end');
  coordinate(incoming.lastReadSeq, 'server read position');
  coordinate(incoming.unreadCount, 'unread count');
  if (incoming.lastMentionSeq !== null)
    coordinate(incoming.lastMentionSeq, 'mention position', 1);
  if (current.threadId !== incoming.threadId)
    throw new Error('Attention snapshot belongs to another thread');
  if (current.server && incoming.threadFeedId <= current.server.threadFeedId)
    return current;
  return {
    threadId: current.threadId,
    server: { ...incoming },
    localReadSeq: current.localReadSeq ?? incoming.lastReadSeq,
  };
}

/** Stable viewport progress is monotonic locally, independently of server rollback. */
export function advanceLocalAttentionRead(
  current: LocalThreadAttention,
  seq: number,
): LocalThreadAttention {
  coordinate(seq, 'local read position');
  if (current.localReadSeq !== null && seq <= current.localReadSeq)
    return current;
  return {
    ...current,
    localReadSeq: seq,
  };
}

/** Count known eligible message slots, including tombs, in (afterSeq, throughSeq]. */
export function attentionCountRange(current: LocalThreadAttention) {
  if (!current.server || current.localReadSeq === null) return null;
  return {
    threadId: current.threadId,
    afterSeq: Math.min(
      current.server.messageEndSeq,
      current.server.lastReadSeq,
      current.localReadSeq,
    ),
    throughSeq: Math.min(
      current.server.messageEndSeq,
      Math.max(current.server.lastReadSeq, current.localReadSeq),
    ),
  };
}

/** Rebase from the raw server count, never from an already-corrected badge. */
export function projectThreadAttention(
  current: LocalThreadAttention,
  intervalCount: number,
) {
  const range = attentionCountRange(current);
  if (!range || !current.server || current.localReadSeq === null) return null;
  if (
    !Number.isInteger(intervalCount) ||
    intervalCount < 0 ||
    intervalCount > range.throughSeq - range.afterSeq
  )
    throw new Error('Invalid attention interval count');
  const direction = Math.sign(
    current.server.lastReadSeq - current.localReadSeq,
  );
  return {
    threadId: current.threadId,
    threadFeedId: current.server.threadFeedId,
    lastReadSeq: current.localReadSeq,
    unreadCount: Math.max(
      0,
      current.server.unreadCount + direction * intervalCount,
    ),
    hasUnreadMention:
      current.server.lastMentionSeq !== null &&
      current.server.lastMentionSeq > current.localReadSeq,
  };
}

/** Confirmed private label, delivered by a successful mutation or a committed feed page. */
export type ThreadAliasApplied = Pick<
  ThreadFeedSnapshot,
  'threadId' | 'threadFeedId' | 'alias'
>;

/** Metadata-only feed revisions must not re-alert existing unread messages. */
export function threadNotificationChanged(
  previous: ThreadFeedSnapshot | null | undefined,
  next: ThreadFeedSnapshot,
): boolean {
  return (
    !previous ||
    previous.messageEndSeq !== next.messageEndSeq ||
    previous.tombstoneEndSeq !== next.tombstoneEndSeq ||
    previous.lastReadSeq !== next.lastReadSeq ||
    previous.unreadCount !== next.unreadCount ||
    previous.lastMentionSeq !== next.lastMentionSeq
  );
}
