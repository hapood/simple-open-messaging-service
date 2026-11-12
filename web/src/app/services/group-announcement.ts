import type { ConversationItem } from './model';

/** A cached announcement is presentable only after the group-meta cursor has
 * reached the latest server-advertised head, and no full recovery is open. */
export function isGroupMetaCurrent(
  thread: ConversationItem | undefined,
): boolean {
  if (
    thread?.type !== 'GROUP' ||
    thread.conversationState === 'READ_ONLY' ||
    thread.meta.recoveryThrough != null
  )
    return false;
  const target = thread.groupMetaFeedEndId;
  const cursor = thread.meta.groupMetaFeedId;
  if (
    target == null ||
    !/^(0|[1-9]\d*)$/.test(target) ||
    !/^(0|[1-9]\d*)$/.test(cursor) ||
    BigInt(cursor) < BigInt(target)
  )
    return false;
  return true;
}

export function currentGroupAnnouncement(
  thread: ConversationItem | undefined,
): {
  feedId: string;
  text: string;
  createdAt: number;
  originCreatedAt: number | null;
} | null {
  if (!isGroupMetaCurrent(thread) || thread?.type !== 'GROUP') return null;
  const { announcementFeedId, announcementText } = thread.meta;
  return announcementFeedId != null &&
    announcementText != null &&
    thread.meta.announcementCreatedAt != null
    ? {
        feedId: announcementFeedId,
        text: announcementText,
        createdAt: thread.meta.announcementCreatedAt,
        originCreatedAt: thread.meta.announcementOriginCreatedAt,
      }
    : null;
}
