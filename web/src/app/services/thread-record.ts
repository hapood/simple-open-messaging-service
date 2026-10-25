import type { LocalThreadAttention } from '../../../../shared/thread-attention';
import type { ConversationItem } from './model';

export type StoredThreadAttention = Omit<LocalThreadAttention, 'previews'>;

/** One typed row per conversation. Profile content is stored only in the revision-keyed profile store. */
export type StoredThread = StoredThreadAttention & {
  lastMessageAt: number | null;
  lastMessageSeq: number | null;
  muted: boolean;
  pinned: boolean;
  pinnedAt: number | null;
  lastMessagePreview: string | null;
  lastMessageSenderAccount: string | null;
  lastMessageSenderNamespaceId: number | null;
  projectedUnreadCount: number;
  mentionMe: boolean;
  mentionAll: boolean;
  subjectId?: number;
  subjectDeleted?: boolean;
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
  const common = {
    lastMessageAt: item.lastMessageAt,
    lastMessageSeq: item.lastMessageSeq,
    muted: item.muted,
    pinned: item.pinned,
    pinnedAt: item.pinnedAt,
    lastMessagePreview: item.lastMessagePreview ?? null,
    lastMessageSenderAccount: item.lastMessageSenderAccount ?? null,
    lastMessageSenderNamespaceId: item.lastMessageSenderNamespaceId ?? null,
    projectedUnreadCount: item.unreadCount,
    mentionMe: item.mentionUnread.includes('me'),
    mentionAll: item.mentionUnread.includes('all'),
  };
  if (item.type === 'P2P')
    return {
      ...common,
      subjectDeleted: item.peerUser.isDeleted,
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
  namespaceId: number;
  profile?: { name: string; bio: string };
}

/** Restore a stored row into a presentation object without mutable display domains. */
export function restoreThread(
  row: StoredThread,
  subject: RestoredThreadSubject,
): ConversationItem {
  const common = {
    threadId: row.threadId,
    publisherNamespaceId: row.publisherNamespaceId,
    selfMentionNamespaceId: row.selfMentionNamespaceId,
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
    lastMessageSenderAccount: row.lastMessageSenderAccount,
    lastMessageSenderNamespaceId: row.lastMessageSenderNamespaceId,
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
      peerUser: {
        account: row.profileAccount,
        namespaceId: subject.namespaceId,
        name: subject.profile?.name ?? row.profileAccount,
        bio: subject.profile?.bio ?? '',
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
      namespaceId: subject.namespaceId,
      name: subject.profile?.name ?? row.profileAccount,
      description: subject.profile?.bio ?? '',
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

/** Restore known subject coordinates without resolving display content inside a write transaction. */
export function restoreThreadForStorageMutation(
  row: StoredThread,
): ConversationItem {
  return restoreThread(row, { namespaceId: row.publisherNamespaceId });
}
