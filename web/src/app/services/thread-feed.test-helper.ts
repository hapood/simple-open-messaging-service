import type { ThreadFeedSnapshot } from '../../../../shared/thread-attention';
import type { ThreadStateSnapshot } from '../../../../shared/thread-state';

type StructureFields = Pick<ThreadStateSnapshot, 'profile'> &
  Partial<Omit<ThreadStateSnapshot, 'threadId' | 'profile'>>;
type FeedFields = Pick<ThreadFeedSnapshot, 'profile'> &
  Partial<Omit<ThreadFeedSnapshot, 'threadId' | 'profile'>>;

/** Tests must supply the actual identity; there is no fallback peer. */
export function threadStructure(
  threadId: number,
  fields: StructureFields,
): ThreadStateSnapshot {
  return {
    threadId,
    type: 'P2P',
    authorityNamespaceId: 0,
    conversationState: 'ACTIVE',
    blocked: false,
    role: null,
    ...fields,
  };
}

export function threadFeedSnapshot(
  threadId: number,
  fields: FeedFields,
): ThreadFeedSnapshot {
  return {
    ...threadStructure(threadId, { profile: fields.profile }),
    threadFeedId: 1,
    alias: null,
    threadProfileRev: fields.profile.profileRev,
    messageEndSeq: 0,
    tombstoneEndSeq: 0,
    groupMetaFeedEndId: null,
    joinRequestEndFeedId: 0,
    joinRequestReadFeedId: -1,
    groupInviteEndFeedId: 0,
    announcementReadFeedId: 0,
    lastReadSeq: 0,
    unreadCount: 0,
    lastMentionSeq: null,
    previews: [],
    ...fields,
  };
}
