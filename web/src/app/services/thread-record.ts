import type { LocalThreadAttention } from '../../../../shared/thread-attention';
import type {
  ConversationItem,
  GroupMetaSlot,
  LocalThreadPatch,
} from './model';

export type StoredThreadAttention = Omit<LocalThreadAttention, 'previews'>;

/** Flat thread row: coordinates, feed state, and read positions. Group-owned
 * state lives in StoredGroupMeta; profile content only in the revision-keyed
 * profile store. */
export type StoredThread = StoredThreadAttention & {
  lastMessageAt: number | null;
  muted: boolean;
  pinned: boolean;
  pinnedAt: number | null;
  lastMessagePreview: string | null;
  lastMessageSenderAccount: string | null;
  lastMessageSenderNamespaceId: number | null;
  projectedUnreadCount: number;
  mentionMe: boolean;
  mentionAll: boolean;
};

/** Apply only operation-supplied fields to the latest row in the write transaction. */
export function applyLocalThreadPatch(
  row: StoredThread,
  patch: LocalThreadPatch,
): StoredThread {
  const next = { ...row };
  if (patch.muted !== undefined) next.muted = patch.muted;
  if (patch.pinned !== undefined) next.pinned = patch.pinned;
  if (patch.pinnedAt !== undefined) next.pinnedAt = patch.pinnedAt;
  if (patch.blocked !== undefined) next.blocked = patch.blocked;
  if (patch.conversationState !== undefined)
    next.conversationState = patch.conversationState;
  if (patch.announcementReadFeedId !== undefined)
    next.announcementReadFeedId = Math.max(
      row.announcementReadFeedId,
      patch.announcementReadFeedId,
    );
  if (
    patch.joinRequestReadFeedId !== undefined &&
    row.joinRequestReadFeedId >= 0
  )
    next.joinRequestReadFeedId = Math.min(
      row.joinRequestEndFeedId,
      Math.max(row.joinRequestReadFeedId, patch.joinRequestReadFeedId),
    );
  return next;
}

/** Dedicated group_meta row mirrored by GroupMetaSlot. */
export type StoredGroupMeta = GroupMetaSlot & { threadId: number };

/** Initialize local columns once. Feed updates must preserve the latest stored values. */
export function createStoredThread(state: StoredThreadAttention): StoredThread {
  return {
    ...state,
    lastMessageAt: null,
    muted: false,
    pinned: false,
    pinnedAt: null,
    lastMessagePreview: null,
    lastMessageSenderAccount: null,
    lastMessageSenderNamespaceId: null,
    projectedUnreadCount: 0,
    mentionMe: false,
    mentionAll: false,
  };
}

export interface RestoredThreadSubject {
  profile?: { name: string; bio: string; avatarDigest?: string | null };
}

/** Restore a thread row (plus its group meta row for groups) into a
 * presentation object without mutable display domains. */
export function restoreThread(
  row: StoredThread,
  subject: RestoredThreadSubject,
  meta?: StoredGroupMeta,
): ConversationItem {
  const common = {
    threadId: row.threadId,
    publisherNamespaceId: row.publisherNamespaceId,
    selfMentionNamespaceId: row.selfMentionNamespaceId,
    visible: true,
    threadFeedId: row.threadFeedId,
    role: row.role,
    lastMessageAt: row.lastMessageAt,
    messageEndSeq: row.messageEndSeq,
    groupMetaFeedEndId: row.groupMetaFeedEndId,
    muted: row.muted,
    blocked: row.blocked,
    pinned: row.pinned,
    pinnedAt: row.pinnedAt,
    alias: row.alias,
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
    account: row.profileAccount,
    profile: {
      name: subject.profile?.name ?? row.profileAccount,
      bio: subject.profile?.bio ?? '',
      avatarDigest: subject.profile?.avatarDigest ?? null,
    },
  };
  if (row.type === 'P2P')
    return {
      ...common,
      type: 'P2P',
    };
  if (!meta || meta.threadId !== row.threadId)
    throw new Error('stored group thread is missing its meta row');
  return {
    ...common,
    type: 'GROUP',
    meta: {
      memberCount: meta.memberCount,
      groupMetaFeedId: meta.groupMetaFeedId,
      announcementFeedId: meta.announcementFeedId,
      announcementText: meta.announcementText,
      recoveryThrough: meta.recoveryThrough,
      recoveryAnnouncementFeedId: meta.recoveryAnnouncementFeedId,
      recoveryAnnouncementText: meta.recoveryAnnouncementText,
    },
  };
}
