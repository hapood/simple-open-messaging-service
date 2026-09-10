import type { ConversationItem } from './model';
import type { ThreadFeedSnapshot } from '../../../../shared/thread-attention';
import type { NotificationDescriptor } from './notification-descriptor.model';
import { cachedAvatarDataUrl } from './cached-avatar';
import {
  conversationAvatarIdentityId,
  conversationAvatarSrc,
} from '../components/user-avatar/conversation-avatar.util';

export async function threadNotificationIcon(
  storage: Parameters<typeof cachedAvatarDataUrl>[0],
  item: ConversationItem,
): Promise<string> {
  const id = conversationAvatarIdentityId(item);
  const identity = `${item.type === 'GROUP' ? 'g' : 'u'}${id}`;
  return (
    (await cachedAvatarDataUrl(
      storage,
      identity,
      conversationAvatarSrc(item) ?? '',
    )) ?? '/icons/icon-192.png'
  );
}

/** Published only after the existing local unread projection succeeds. */
export interface ThreadNotificationUpdate {
  item: ConversationItem;
  state: ThreadFeedSnapshot;
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
  previewCount: 1 | 5 = 1,
): NotificationDescriptor {
  const preview = state.previews
    ?.filter((p) => p.seq > (item.lastReadSeq ?? state.lastReadSeq))
    .reduce<
      NonNullable<ThreadFeedSnapshot['previews']>[number] | undefined
    >((latest, p) => (!latest || p.seq > latest.seq ? p : latest), undefined);
  const fallback = preview?.sender
    ? `${preview.sender.account}@${preview.sender.domain}`
    : 'SOMS';
  const title =
    item.type === 'GROUP'
      ? item.group.name || fallback
      : item.alias ||
        item.peerUser.name ||
        `${item.peerUser.account}@${item.peerUser.domain}`;
  const textFor = (
    preview: NonNullable<ThreadFeedSnapshot['previews']>[number],
  ) =>
    preview.status === 'USER_RETRACTION'
      ? copy.retracted
      : preview.status === 'MODERATION_REMOVAL'
        ? copy.removed
        : preview.text || copy.privateBody;
  const recent = state.previews
    ?.filter((p) => p.seq > (item.lastReadSeq ?? state.lastReadSeq))
    .sort((a, b) => b.seq - a.seq)
    .slice(0, previewCount);
  const text =
    previewCount === 5 && recent?.length
      ? recent.reverse().map(textFor).join('\n')
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
