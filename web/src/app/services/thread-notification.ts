import type { ConversationItem } from './model';
import type { ThreadFeedSnapshot } from '../../../../shared/thread-attention';
import type { NotificationDescriptor } from './notification-descriptor.model';
import type { WebdbStorage } from './webdb-storage';
import { avatarBlobDataUrl } from './profile-avatar-bytes';

export async function threadNotificationIcon(
  storage: Pick<WebdbStorage, 'getProfile' | 'getProfileAvatarBlob'>,
  item: ConversationItem,
): Promise<string> {
  const subject = item.type === 'GROUP' ? item.group : item.peerUser;
  if (item.profileRev < 1) return '/icons/icon-192.png';
  const profile = await storage.getProfile({
    publisherNamespaceId: subject.namespaceId,
    lookup: 'ACCOUNT_PROFILE',
    target: {
      profileNamespaceId: subject.namespaceId,
      account: subject.account,
      rev: item.profileRev,
    },
  });
  const blob = profile?.avatarDigest
    ? await storage.getProfileAvatarBlob(profile.avatarDigest)
    : undefined;
  return blob ? avatarBlobDataUrl(blob) : '/icons/icon-192.png';
}

/** Published only after the existing local unread projection succeeds. */
export interface ThreadNotificationUpdate {
  item: ConversationItem;
  state: Pick<
    ThreadFeedSnapshot,
    'threadFeedId' | 'previews' | 'lastReadSeq' | 'alias'
  > &
    Partial<ThreadFeedSnapshot>;
}

export function threadNotificationDescriptor(
  { item, state }: ThreadNotificationUpdate,
  previewMode: 'message' | 'private',
  copy: {
    lang: string;
    privateBody: string;
    retracted: string;
    removed: string;
  },
): NotificationDescriptor {
  const preview = state.previews
    ?.filter((p) => p.seq > (item.lastReadSeq ?? state.lastReadSeq))
    .reduce<
      NonNullable<ThreadFeedSnapshot['previews']>[number] | undefined
    >((latest, p) => (!latest || p.seq > latest.seq ? p : latest), undefined);
  const fallback = preview?.sender.account ?? 'Unknown';
  const title =
    state.alias ||
    (item.type === 'GROUP'
      ? item.group.name || fallback
      : item.peerUser.name ||
        `${item.peerUser.account}@${item.peerUser.domain}`);
  const textFor = (
    preview: NonNullable<ThreadFeedSnapshot['previews']>[number],
  ) =>
    preview.status === 'USER_RETRACTION'
      ? copy.retracted
      : preview.status === 'MODERATION_REMOVAL'
        ? copy.removed
        : preview.text || copy.privateBody;
  const recent = state.previews?.filter(
    (p) => p.seq > (item.lastReadSeq ?? state.lastReadSeq),
  );
  const text = recent?.length
    ? recent.map(textFor).join('\n')
    : preview
      ? textFor(preview)
      : copy.privateBody;
  return {
    tag: `soms-thread-${item.threadId}`,
    kind: 'thread-message',
    title,
    body: previewMode === 'private' ? copy.privateBody : text,
    count: item.blocked ? 0 : item.unreadCount,
    lang: copy.lang,
    icon: '/icons/icon-192.png',
    renotify: true,
    silent: item.muted,
    ...(item.mentionUnread.length ? { attention: 'mention' as const } : {}),
    previewMode,
    data: { threadId: item.threadId, seq: preview?.seq },
  };
}
