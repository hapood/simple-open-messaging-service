import type { AccountState } from '../../../../shared/account-state';
import type { ThreadFeedSnapshot } from '../../../../shared/thread-attention';
import type { NotificationDescriptor } from './notification-descriptor.model';
import type { PreferenceStorage } from './preference-storage';
import en from '../i18n/en.json';
import zh from '../i18n/zh-CN.json';

export function groupRequestNotificationChanged(
  previous: ThreadFeedSnapshot | null | undefined,
  next: ThreadFeedSnapshot,
): boolean {
  return (
    !previous ||
    previous.joinRequestEndFeedId !== next.joinRequestEndFeedId ||
    previous.joinRequestReadFeedId !== next.joinRequestReadFeedId ||
    previous.blocked !== next.blocked ||
    previous.role !== next.role ||
    previous.conversationState !== next.conversationState
  );
}

export function friendRequestNotificationChanged(
  previous: AccountState,
  next: AccountState,
): boolean {
  return (
    previous.intentRequestEndId !== next.intentRequestEndId ||
    previous.intentRequestReadId !== next.intentRequestReadId ||
    previous.intentRequestOptimisticReadId !==
      next.intentRequestOptimisticReadId
  );
}

export async function requestNotificationSettings(
  preferences: Pick<PreferenceStorage, 'get'>,
  language: string,
) {
  const [enabled, sound, mode] = await Promise.all([
    preferences.get<boolean>('device', 'notificationEnabled'),
    preferences.get<boolean>('device', 'notificationSound'),
    preferences.get<string>('device', 'notificationPreviewMode'),
  ]);
  return {
    enabled: enabled !== false,
    sound: sound !== false,
    private: mode === 'private',
    language,
  };
}

type Settings = Awaited<ReturnType<typeof requestNotificationSettings>>;

export function friendRequestNotification(
  state: AccountState,
  settings: Settings,
): NotificationDescriptor {
  const locale = settings.language.startsWith('zh') ? zh : en;
  const end = BigInt(state.intentRequestEndId ?? '0');
  const read = BigInt(state.intentRequestReadId ?? '0');
  const optimistic = BigInt(state.intentRequestOptimisticReadId ?? '0');
  return {
    kind: 'friend-requests',
    title: locale.settings.notifNewRequests,
    body: locale.settings.notifNewRequests,
    count: settings.enabled && end > read && end > optimistic ? 1 : 0,
    lang: settings.language,
    icon: '/icons/icon-192.png',
    silent: !settings.sound,
    previewMode: settings.private ? 'private' : 'message',
    data: { target: { kind: 'friend-requests' } },
  };
}

/** Feed positions are unread markers, not request counts. Never subtract them. */
export function groupRequestNotification(
  state: ThreadFeedSnapshot,
  title: string,
  settings: Settings,
  muted = false,
): NotificationDescriptor {
  const locale = settings.language.startsWith('zh') ? zh : en;
  return {
    kind: 'group-join-requests',
    title: settings.private ? locale.group.joinRequests : title,
    body: locale.settings.notifJoinRequests,
    count:
      settings.enabled &&
      !state.blocked &&
      state.type === 'GROUP' &&
      state.conversationState === 'ACTIVE' &&
      (state.role === 'OWNER' || state.role === 'ADMIN') &&
      state.joinRequestReadFeedId >= 0 &&
      state.joinRequestEndFeedId > state.joinRequestReadFeedId
        ? 1
        : 0,
    lang: settings.language,
    icon: '/icons/icon-192.png',
    silent: !settings.sound || muted,
    previewMode: settings.private ? 'private' : 'message',
    data: {
      target: { kind: 'group-join-requests', threadId: state.threadId },
    },
  };
}
