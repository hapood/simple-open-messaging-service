import { WebdbStorage } from './webdb-storage';
import { PreferenceStorage } from './preference-storage';
import { syncThreadFeed } from './thread-feed-sync';
import {
  attentionCountRange,
  projectThreadAttention,
  threadNotificationChanged,
} from '../../../../shared/thread-attention';
import {
  threadNotificationDescriptor,
  threadNotificationIcon,
} from './thread-notification';
import { createP2PConversation, type User } from './model';
import type { NotificationDescriptor } from './notification-descriptor.model';
import type {
  GroupMetaProfileResolver,
  GroupMetaRequester,
} from './group-meta-sync';

export interface PushThreadResult {
  userId: number;
  consumed: boolean;
  cursor: number;
  notifications: NotificationDescriptor[];
  error?: string;
}

/** Background projection shares the normal feed drain, storage and optimistic interval-count algorithm. */
export async function syncPushThreads(
  storage: WebdbStorage,
  userId: number,
  target: number,
  request: Parameters<typeof syncThreadFeed>[2],
  preferences: Pick<PreferenceStorage, 'get'>,
  copy: Parameters<typeof threadNotificationDescriptor>[2],
  requestGroupMeta: GroupMetaRequester,
  resolveGroupMetaProfile: GroupMetaProfileResolver,
): Promise<PushThreadResult> {
  const previous = new Map(
    (await storage.getThreadStates()).map((state) => [
      state.threadId,
      state.server,
    ]),
  );
  const result = await syncThreadFeed(
    storage,
    target,
    request,
    requestGroupMeta,
    resolveGroupMetaProfile,
  );
  const notifications: NotificationDescriptor[] = [];
  if (!result.states.length)
    return { ...result, consumed: false, userId, notifications };
  const [rows, states, self, enabled, sound, mode] = await Promise.all([
    storage.getThreads(),
    storage.getThreadStates(),
    storage.getMeta('selfProfile'),
    preferences.get<boolean>('device', 'notificationEnabled'),
    preferences.get<boolean>('device', 'notificationSound'),
    preferences.get<string>('device', 'notificationPreviewMode'),
  ]);
  const owner = self as User | undefined;
  const current = new Map(states.map((state) => [state.threadId, state]));
  for (const delivered of result.states) {
    const state = current.get(delivered.threadId);
    if (
      !state?.server ||
      state.server.threadFeedId !== delivered.server?.threadFeedId
    )
      continue;
    if (!threadNotificationChanged(previous.get(state.threadId), state.server))
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
        { account: owner.account, domain: 'local', namespaceId: 0 },
      );
    }
    const projection = projectThreadAttention(state, count)!;
    const sender = delivered.server.previews?.[0]?.sender;
    // Missing relationship metadata affects the title only; never invent or persist a relationship.
    const item =
      rows.find((row) => row.threadId === state.threadId) ??
      createP2PConversation(state.threadId, {
        account: sender?.account ?? '',
        domain: sender?.domain ?? '',
        name: sender ? `${sender.account}@${sender.domain}` : 'SOMS',
      });
    const descriptor = threadNotificationDescriptor(
      {
        item: {
          ...item,
          lastReadSeq: projection.lastReadSeq,
          unreadCount: projection.unreadCount,
          mentionUnread: projection.hasUnreadMention ? ['me'] : [],
        },
        state: { ...state.server, previews: delivered.server.previews },
      },
      mode === 'private' ? 'private' : 'message',
      copy,
    );
    descriptor.silent = !!descriptor.silent || sound === false;
    if (enabled !== false) {
      if (descriptor.count > 0)
        descriptor.icon = await threadNotificationIcon(storage, item);
      notifications.push(descriptor);
    }
  }
  return {
    userId,
    consumed: true,
    cursor: result.cursor,
    notifications,
    ...(result.error ? { error: result.error } : {}),
  };
}
