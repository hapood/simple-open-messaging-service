import type { LocalThreadAttention } from '../../../../shared/thread-attention';
import type {
  ConversationItem,
  GroupMetaSlot,
  LocalThreadPatch,
} from './model';

/** Complete durable local thread state, not a wire snapshot or a UI item.
 * Preview payloads, group metadata, and revision-keyed profiles have separate stores. */
export interface LocalThreadState {
  threadId: number;
  threadFeedId: number;
  type: 'P2P' | 'GROUP';
  publisherNamespaceId: number;
  selfMentionNamespaceId: number | null;
  profileAccount: string;
  profileRev: number;
  conversationState: 'ACTIVE' | 'READ_ONLY';
  blocked: boolean;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
  alias: string | null;
  messageEndSeq: number;
  tombstoneEndSeq: number;
  groupMetaFeedEndId: string | null;
  joinRequestEndFeedId: number;
  joinRequestReadFeedId: number;
  groupInviteEndFeedId: number;
  lastReadSeq: number;
  localReadSeq: number;
  announcementReadFeedId: number;
  unreadCount: number;
  lastMentionSeq: number | null;
  /** Durable deletion progress, initialized only when this thread is created. */
  deletedHwm: number;
  /** Known history ceiling; null until learned by the message source. */
  messageHead: number | null;
  muted: boolean;
  pinned: boolean;
  pinnedAt: number | null;
  projectedUnreadCount: number;
  mentionMe: boolean;
  mentionAll: boolean;
};

/** Apply only operation-supplied fields to the latest row in the write transaction. */
export function applyLocalThreadPatch(
  row: LocalThreadState,
  patch: LocalThreadPatch,
): LocalThreadState {
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

/** Explicit boundary: never spread transport-only preview payloads into a thread row. */
export function threadAttentionFields(state: LocalThreadAttention) {
  return {
    threadId: state.threadId,
    threadFeedId: state.threadFeedId,
    type: state.type,
    publisherNamespaceId: state.publisherNamespaceId,
    selfMentionNamespaceId: state.selfMentionNamespaceId,
    profileAccount: state.profileAccount,
    profileRev: state.profileRev,
    conversationState: state.conversationState,
    blocked: state.blocked,
    role: state.role,
    alias: state.alias,
    messageEndSeq: state.messageEndSeq,
    tombstoneEndSeq: state.tombstoneEndSeq,
    groupMetaFeedEndId: state.groupMetaFeedEndId,
    joinRequestEndFeedId: state.joinRequestEndFeedId,
    joinRequestReadFeedId: state.joinRequestReadFeedId,
    groupInviteEndFeedId: state.groupInviteEndFeedId,
    lastReadSeq: state.lastReadSeq,
    localReadSeq: state.localReadSeq,
    announcementReadFeedId: state.announcementReadFeedId,
    unreadCount: state.unreadCount,
    lastMentionSeq: state.lastMentionSeq,
  };
}

/** Initialize local columns once. Feed updates must preserve the latest stored values. */
export function createLocalThreadState(state: LocalThreadAttention): LocalThreadState {
  return {
    ...threadAttentionFields(state),
    deletedHwm: state.tombstoneEndSeq,
    messageHead: null,
    muted: false,
    pinned: false,
    pinnedAt: null,
    projectedUnreadCount: 0,
    mentionMe: false,
    mentionAll: false,
  };
}

export interface RestoredThreadSubject {
  profile?: { name: string; bio: string; avatarDigest?: string | null };
}

/** Preview-owned fields joined from the independent preview record. */
export interface ThreadPreviewView {
  createdAt: string;
  senderAccount: string;
  senderProfileNamespaceId: number;
  status: 'LIVE' | 'USER_RETRACTION' | 'MODERATION_REMOVAL';
  text: string | null;
}

export function projectThreadPreview(preview: ThreadPreviewView | undefined) {
  return {
    lastMessagePreview: preview
      ? preview.status === 'LIVE'
        ? (preview.text ?? '')
        : preview.status === 'USER_RETRACTION'
          ? '[Message retracted]'
          : '[Message removed by administrator]'
      : null,
    lastMessageAt: preview ? Date.parse(preview.createdAt) : null,
    lastMessageSenderAccount: preview?.senderAccount ?? null,
    lastMessageSenderNamespaceId: preview?.senderProfileNamespaceId ?? null,
  };
}

/** Join independent thread, preview, profile, and group meta records for display. */
export function restoreThread(
  row: LocalThreadState,
  subject: RestoredThreadSubject,
  preview: ThreadPreviewView | undefined,
  meta?: StoredGroupMeta,
): ConversationItem {
  const common = {
    threadId: row.threadId,
    publisherNamespaceId: row.publisherNamespaceId,
    selfMentionNamespaceId: row.selfMentionNamespaceId,
    visible: true,
    threadFeedId: row.threadFeedId,
    role: row.role,
    ...projectThreadPreview(preview),
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
      announcementCreatedAt: meta.announcementCreatedAt,
      announcementOriginCreatedAt: meta.announcementOriginCreatedAt,
      recoveryThrough: meta.recoveryThrough,
      recoveryAnnouncementFeedId: meta.recoveryAnnouncementFeedId,
      recoveryAnnouncementText: meta.recoveryAnnouncementText,
      recoveryAnnouncementCreatedAt: meta.recoveryAnnouncementCreatedAt,
      recoveryAnnouncementOriginCreatedAt: meta.recoveryAnnouncementOriginCreatedAt,
    },
  };
}
