import type { ConversationItem } from './model';

/** A cached announcement is presentable only after the group-meta cursor has
 * reached the latest server-advertised head, and no full recovery is open. */
export function isGroupMetaCurrent(
  thread: ConversationItem | undefined,
): boolean {
  if (
    thread?.type !== 'GROUP' ||
    thread.conversationState === 'READ_ONLY' ||
    thread.groupMetaRecoveryThrough != null
  )
    return false;
  const target = thread.groupMetaTargetFeedId;
  const cursor = thread.group.groupMetaFeedId;
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
): { feedId: string; text: string } | null {
  if (!isGroupMetaCurrent(thread) || thread?.type !== 'GROUP') return null;
  const announcement = thread.group.announcement;
  return announcement?.text
    ? { feedId: announcement.feedId, text: announcement.text }
    : null;
}
