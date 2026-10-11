import {
  isThreadStateSnapshot,
  type ThreadStateSnapshot,
} from './thread-state.js';

/** One complete conversation snapshot. Its account-scoped ID orders visible thread-list items. */
export interface ThreadFeedSnapshot extends ThreadStateSnapshot {
  threadFeedId: number;
  threadId: number;
  /** Private label owned by this account. Null restores the canonical name. */
  alias: string | null;
  profileRev: number;
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
  /** Account-local acknowledgement in the group-meta coordinate space. */
  announcementReadFeedId: number;
  unreadCount: number;
  lastMentionSeq: number | null;
  previews?: Array<{
    seq: number;
    createdAt: string;
    sender: {
      account: string;
      profileNamespaceId: number;
      profileRev: number;
    };
    status: 'LIVE' | 'USER_RETRACTION' | 'MODERATION_REMOVAL';
    text?: string;
  }>;
}

/** A committed feed snapshot plus the independent local read position. */
export type LocalThreadAttention = ThreadFeedSnapshot & {
  localReadSeq: number;
};

/** Extract the wire snapshot only when needed for notification comparison. */
export function attentionSnapshot(
  state: LocalThreadAttention | undefined,
): ThreadFeedSnapshot | null {
  if (!state) return null;
  const { localReadSeq: _localReadSeq, ...snapshot } = state;
  return snapshot;
}

const INT32_MAX = 2_147_483_647;

function coordinate(value: number, name: string, minimum = 0): void {
  if (!Number.isInteger(value) || value < minimum || value > INT32_MAX)
    throw new Error(`Invalid attention ${name}`);
}

/** Never replace an established display position with a remote read position. */
export function mergeThreadAttention(
  current: LocalThreadAttention | undefined,
  incoming: ThreadFeedSnapshot,
): LocalThreadAttention {
  if (!isThreadStateSnapshot(incoming))
    throw new Error('Invalid thread structure');
  if (incoming.alias !== null && typeof incoming.alias !== 'string')
    throw new Error('Invalid thread alias');
  coordinate(incoming.threadId, 'threadId', 1);
  coordinate(incoming.threadFeedId, 'feed ID', 1);
  coordinate(incoming.profileRev, 'profile revision');
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
  coordinate(incoming.announcementReadFeedId, 'announcement read position');
  coordinate(incoming.unreadCount, 'unread count');
  if (incoming.lastMentionSeq !== null)
    coordinate(incoming.lastMentionSeq, 'mention position', 1);
  if (current && current.threadId !== incoming.threadId)
    throw new Error('Attention snapshot belongs to another thread');
  if (current && incoming.threadFeedId <= current.threadFeedId) return current;
  return {
    ...incoming,
    // A newer server read position is authoritative and catches the local
    // viewport up. A locally advanced viewport remains ahead until the
    // server catches up; neither position is capped here.
    localReadSeq: Math.max(
      current?.localReadSeq ?? incoming.lastReadSeq,
      incoming.lastReadSeq,
    ),
  };
}

/** Stable viewport progress is monotonic locally, independently of server rollback. */
export function advanceLocalAttentionRead(
  current: LocalThreadAttention,
  seq: number,
): LocalThreadAttention {
  coordinate(seq, 'local read position');
  if (seq <= current.localReadSeq) return current;
  return {
    ...current,
    localReadSeq: seq,
  };
}

/** A position may lead the current message head locally; only range
 * calculations clamp it because deletion facts are known only through that
 * head. */
function boundedReadSeq(position: number, messageEndSeq: number): number {
  return Math.min(position, messageEndSeq);
}

function effectiveReadSeq(current: LocalThreadAttention): number {
  return Math.max(current.lastReadSeq, current.localReadSeq);
}

/** Count known eligible message slots between server and local read positions. */
export function attentionCountRange(current: LocalThreadAttention) {
  const serverReadSeq = boundedReadSeq(
    current.lastReadSeq,
    current.messageEndSeq,
  );
  const localReadSeq = boundedReadSeq(
    current.localReadSeq,
    current.messageEndSeq,
  );
  return {
    threadId: current.threadId,
    afterSeq: Math.min(serverReadSeq, localReadSeq),
    throughSeq: Math.max(serverReadSeq, localReadSeq),
  };
}

/** Rebase from the raw server count, never from an already-corrected badge. */
export function projectThreadAttention(
  current: LocalThreadAttention,
  intervalCount: number,
) {
  const range = attentionCountRange(current);
  if (
    !Number.isInteger(intervalCount) ||
    intervalCount < 0 ||
    intervalCount > range.throughSeq - range.afterSeq
  )
    throw new Error('Invalid attention interval count');
  const serverReadSeq = current.lastReadSeq;
  const localReadSeq = current.localReadSeq;
  const unreadDelta =
    localReadSeq > serverReadSeq
      ? -intervalCount
      : serverReadSeq > localReadSeq
        ? intervalCount
        : 0;
  const unreadCount = Math.max(0, current.unreadCount + unreadDelta);
  const readSeq = effectiveReadSeq(current);
  return {
    threadId: current.threadId,
    threadFeedId: current.threadFeedId,
    lastReadSeq: readSeq,
    unreadCount,
    hasUnreadMention:
      current.lastMentionSeq !== null && current.lastMentionSeq > readSeq,
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
