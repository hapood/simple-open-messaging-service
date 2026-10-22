import type { ThreadFeedSnapshot } from '../../../../shared/thread-attention';
import type { ThreadStateSnapshot } from '../../../../shared/thread-state';

type StructureFields = Pick<
  ThreadStateSnapshot,
  'publisherNamespaceId' | 'profileAccount' | 'profileRev'
> &
  Partial<
    Omit<
      ThreadStateSnapshot,
      'threadId' | 'publisherNamespaceId' | 'profileAccount' | 'profileRev'
    >
  >;

type FeedFields = StructureFields &
  Partial<Omit<ThreadFeedSnapshot, keyof ThreadStateSnapshot | 'threadId'>>;

/** Tests must supply the actual publisher/profile coordinates; there are no identity fallbacks. */
export function threadStructure(
  threadId: number,
  fields: StructureFields,
): ThreadStateSnapshot {
  return {
    threadId,
    type: 'P2P',
    selfMentionNamespaceId: null,
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
    ...threadStructure(threadId, fields),
    threadFeedId: 1,
    alias: null,
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
