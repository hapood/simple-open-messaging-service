import type { LocalThreadAttention } from '../../../../shared/thread-attention';
import type { ConversationItem } from './model';

export type StoredThreadAttention = Omit<
  LocalThreadAttention,
  'previews'
>;

/** One typed row per conversation. State owns the identity, selected avatar revision and
 * server/local read positions; presentation owns only locally materialized display fields. */
export type StoredThread = StoredThreadAttention & {
  lastMessageAt: number | null;
  lastMessageSeq: number | null;
  muted: boolean;
  pinned: boolean;
  pinnedAt: number | null;
  lastMessagePreview: string | null;
  lastMessageSenderId: string | null;
  projectedUnreadCount: number;
  mentionMe: boolean;
  mentionAll: boolean;
  subjectId?: number;
  subjectName: string;
  subjectAvatar: string;
  subjectBio: string;
  subjectDeleted?: boolean;
  peerProfileMessageSeq?: number;
  groupDissolvedAt?: number | null;
  groupMemberCount?: number;
  groupMetaFeedId?: string;
  groupMetaRecoveryThrough?: string | null;
  groupMetaTargetFeedId?: string | null;
  groupAnnouncementFeedId?: string | null;
  groupAnnouncementText?: string | null;
  recoveryAnnouncementFeedId?: string | null;
  recoveryAnnouncementText?: string | null;
};

/** Updates only presentation columns; combine with the latest feed state inside one transaction. */
export function storeThreadPresentation(
  item: ConversationItem,
): Omit<StoredThread, keyof StoredThreadAttention> {
  const subject = item.type === 'GROUP' ? item.group : item.peerUser;
  const common = {
    lastMessageAt: item.lastMessageAt,
    lastMessageSeq: item.lastMessageSeq,
    muted: item.muted,
    pinned: item.pinned,
    pinnedAt: item.pinnedAt,
    lastMessagePreview: item.lastMessagePreview ?? null,
    lastMessageSenderId: item.lastMessageSenderId ?? null,
    projectedUnreadCount: item.unreadCount,
    mentionMe: item.mentionUnread.includes('me'),
    mentionAll: item.mentionUnread.includes('all'),
    subjectName: subject.name,
    subjectAvatar: subject.avatar,
    subjectBio:
      item.type === 'GROUP' ? item.group.description : item.peerUser.bio,
  };
  if (item.type === 'P2P')
    return {
      ...common,
      subjectDeleted: item.peerUser.isDeleted,
      peerProfileMessageSeq: item.peerProfileMessageSeq,
    };
  if (!Number.isSafeInteger(item.group.id) || item.group.id < 1)
    throw new Error('group thread has no positive local group id');
  return {
    ...common,
    subjectId: item.group.id,
    groupDissolvedAt: item.group.dissolvedAt,
    groupMemberCount: item.group.memberCount,
    groupMetaFeedId: item.group.groupMetaFeedId,
    groupMetaRecoveryThrough: item.groupMetaRecoveryThrough,
    groupMetaTargetFeedId: item.groupMetaTargetFeedId,
    groupAnnouncementFeedId: item.group.announcement?.feedId ?? null,
    groupAnnouncementText: item.group.announcement?.text ?? null,
    recoveryAnnouncementFeedId:
      item.groupMetaRecoveryAnnouncement?.feedId ?? null,
    recoveryAnnouncementText: item.groupMetaRecoveryAnnouncement?.text ?? null,
  };
}

export interface RestoredThreadSubject {
  domain: string;
  namespaceId: number;
}

/** Restore a stored row into a presentation object. The subject identity is supplied by the
 * profile-namespace join; the stored row intentionally contains no mutable domain. */
export function restoreThread(
  row: StoredThread,
  subject: RestoredThreadSubject,
): ConversationItem {
  const common = {
    threadId: row.threadId,
    publisherNamespaceId: row.publisherNamespaceId,
    visible: true,
    threadFeedId: row.threadFeedId,
    role: row.role,
    lastMessageAt: row.lastMessageAt,
    lastMessageSeq: row.lastMessageSeq,
    muted: row.muted,
    blocked: row.blocked,
    pinned: row.pinned,
    pinnedAt: row.pinnedAt,
    alias: row.alias,
    friendshipActive:
      row.type === 'P2P' ? row.conversationState === 'ACTIVE' : undefined,
    conversationState: row.conversationState,
    lastReadSeq: row.localReadSeq,
    announcementReadFeedId: row.announcementReadFeedId,
    unreadCount: row.projectedUnreadCount,
    lastMessagePreview: row.lastMessagePreview,
    lastMessageSenderId: row.lastMessageSenderId,
    mentionUnread: [
      ...(row.mentionMe ? ['me' as const] : []),
      ...(row.mentionAll ? ['all' as const] : []),
    ],
    joinRequestEndFeedId: row.joinRequestEndFeedId,
    joinRequestReadFeedId: row.joinRequestReadFeedId,
    groupInviteEndFeedId: row.groupInviteEndFeedId,
    profileRev: row.profileRev,
  };
  if (row.type === 'P2P')
    return {
      ...common,
      type: 'P2P',
      peerProfileMessageSeq: row.peerProfileMessageSeq,
      peerUser: {
        account: row.profileAccount,
        namespaceId: subject.namespaceId,
        name: row.subjectName,
        avatar: row.subjectAvatar,
        bio: row.subjectBio,
        isGroup: false,
        isDeleted: row.subjectDeleted ?? false,
      },
    };
  if (
    row.subjectId == null ||
    row.groupMemberCount == null ||
    row.groupMetaFeedId == null
  )
    throw new Error('stored group thread is incomplete');
  if (
    (row.groupAnnouncementFeedId != null &&
      row.groupAnnouncementText === undefined) ||
    (row.recoveryAnnouncementFeedId != null &&
      row.recoveryAnnouncementText === undefined)
  )
    throw new Error('stored group announcement is incomplete');
  return {
    ...common,
    type: 'GROUP',
    group: {
      id: row.subjectId,
      account: row.profileAccount,
      domain: subject.domain,
      namespaceId: subject.namespaceId,
      name: row.subjectName,
      avatar: row.subjectAvatar,
      description: row.subjectBio,
      dissolvedAt: row.groupDissolvedAt,
      memberCount: row.groupMemberCount,
      groupMetaFeedId: row.groupMetaFeedId,
      announcement:
        row.groupAnnouncementFeedId == null
          ? null
          : {
              feedId: row.groupAnnouncementFeedId,
              text: row.groupAnnouncementText!,
            },
      threadId: row.threadId,
    },
    groupMetaRecoveryThrough: row.groupMetaRecoveryThrough ?? null,
    groupMetaTargetFeedId: row.groupMetaTargetFeedId,
    groupMetaRecoveryAnnouncement:
      row.recoveryAnnouncementFeedId == null
        ? null
        : {
            feedId: row.recoveryAnnouncementFeedId,
            text: row.recoveryAnnouncementText!,
          },
  };
}

/** Storage mutations use an unresolved subject only inside a transaction. */
export function restoreThreadForStorageMutation(
  row: StoredThread,
): ConversationItem {
  return restoreThread(row, { domain: '', namespaceId: 0 });
}
