import { WebdbStorage } from './webdb-storage';
import { namespaceDisplayDomain } from './profile-namespace-domain';
import { PreferenceStorage } from './preference-storage';
import { syncThreadFeed, type ThreadFeedSyncResult } from './thread-feed-sync';
import {
  attentionCountRange,
  attentionSnapshot,
  projectThreadAttention,
  threadNotificationChanged,
} from '../../../../shared/thread-attention';
import {
  threadNotificationDescriptor,
  threadNotificationIcon,
} from './thread-notification';
import type { User } from './model';
import type { NotificationDescriptor } from './notification-descriptor.model';

export interface PushThreadResult extends ThreadFeedSyncResult {
  userId: number;
  consumed: boolean;
  cursor: number;
  notifications: NotificationDescriptor[];
}

/** Background projection shares the normal feed drain, storage and optimistic interval-count algorithm. */
export async function syncPushThreads(
  storage: WebdbStorage,
  userId: number,
  target: number,
  request: Parameters<typeof syncThreadFeed>[2],
  preferences: Pick<PreferenceStorage, 'get'>,
  copy: Parameters<typeof threadNotificationDescriptor>[2],
): Promise<PushThreadResult> {
  const previous = new Map(
    (await storage.getThreadStates()).map((state) => [
      state.threadId,
      attentionSnapshot(state),
    ]),
  );
  const result = await syncThreadFeed(
    storage,
    target,
    request,
  );
  const notifications: NotificationDescriptor[] = [];
  if (!result.states.length)
    return { ...result, consumed: false, userId, notifications };
  const [rows, states, self, enabled, sound, mode] = await Promise.all([
    storage.getThreads(),
    storage.getThreadStates(),
    storage.readAccountState().then((state) => state.selfProfile),
    preferences.get<boolean>('device', 'notificationEnabled'),
    preferences.get<boolean>('device', 'notificationSound'),
    preferences.get<string>('device', 'notificationPreviewMode'),
  ]);
  const owner = self;
  const current = new Map(states.map((state) => [state.threadId, state]));
  for (const delivered of result.states) {
    const state = current.get(delivered.threadId);
    const snapshot = attentionSnapshot(state);
    const deliveredSnapshot = attentionSnapshot(delivered);
    if (!state || !snapshot || !deliveredSnapshot ||
      snapshot.threadFeedId !== deliveredSnapshot.threadFeedId)
      continue;
    if (!threadNotificationChanged(previous.get(state.threadId), snapshot))
      continue;
    const range = attentionCountRange(state);
    if (!range) continue;
    let count = 0;
    if (range.afterSeq !== range.throughSeq) {
      if (owner?.id !== userId)
        throw new Error('notification account identity unavailable');
      count = await storage.countUnreadMessageSlots(
        state.threadId,
        range.afterSeq,
        range.throughSeq,
        {
          account: owner.account,
          namespaceId: owner.namespaceId,
        },
      );
    }
    const projection = projectThreadAttention(state, count)!;
    // A concurrently deleted local conversation must not produce a fabricated notification.
    const item = rows.find((row) => row.threadId === state.threadId);
    if (!item) continue;
    const subject = item.type === 'GROUP' ? item.group : item.peerUser;
    const [binding] = await storage.getProfileNamespaceBindings([{
      publisherNamespaceId: 0,
      profileNamespaceId: subject.namespaceId,
    }]);
    const descriptor = threadNotificationDescriptor(
      {
        item: {
          ...item,
          lastReadSeq: projection.lastReadSeq,
          unreadCount: projection.unreadCount,
          mentionUnread: projection.hasUnreadMention ? ['me'] : [],
        },
        state: { ...snapshot, previews: deliveredSnapshot.previews },
      },
      mode === 'private' ? 'private' : 'message',
      copy,
      binding ? namespaceDisplayDomain(binding) : null,
    );
    descriptor.silent = !!descriptor.silent || sound === false;
    if (enabled !== false) {
      if (descriptor.count > 0)
        descriptor.icon = await threadNotificationIcon(storage, item);
      notifications.push(descriptor);
    }
  }
  return {
    ...result,
    userId,
    consumed: true,
    cursor: result.cursor,
    notifications,
    ...(result.error ? { error: result.error } : {}),
  };
}
