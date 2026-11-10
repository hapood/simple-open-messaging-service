import { WebdbStorage } from './webdb-storage';
import {
  groupRequestNotification,
  groupRequestNotificationChanged,
  requestNotificationSettings,
} from './request-notification';
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
import type { LocalThreadAttention } from '../../../../shared/thread-attention';
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
  const result = await syncThreadFeed(storage, target, request);
  const notifications: NotificationDescriptor[] = [];
  if (!result.states.length)
    return { ...result, consumed: false, userId, notifications };
  return {
    ...result,
    userId,
    consumed: true,
    notifications: await projectNotificationDelta(
      storage,
      userId,
      preferences,
      copy,
      result.states,
      previous,
    ),
  };
}

/** Delta selection is explicit and never falls back to a complete reconstruction. */
async function projectNotificationDelta(
  storage: WebdbStorage,
  userId: number,
  preferences: Pick<PreferenceStorage, 'get'>,
  copy: Parameters<typeof threadNotificationDescriptor>[2],
  delivered: readonly LocalThreadAttention[],
  previous: ReadonlyMap<number, ReturnType<typeof attentionSnapshot>>,
): Promise<NotificationDescriptor[]> {
  const current = new Map(
    (await storage.getThreadStates()).map((state) => [state.threadId, state]),
  );
  const selected = delivered.flatMap((item) => {
    const state = current.get(item.threadId);
    const snapshot = attentionSnapshot(state);
    const deliveredSnapshot = attentionSnapshot(item);
    return state &&
      snapshot &&
      deliveredSnapshot &&
      snapshot.threadFeedId === deliveredSnapshot.threadFeedId &&
      threadNotificationChanged(previous.get(state.threadId), snapshot)
      ? // The database deliberately retains only the latest preview. This round's
        // notification may use all delivered previews while retaining current read state.
        [{ ...state, previews: item.previews }]
      : [];
  });
  const requests = delivered.flatMap((item) => {
    const state = current.get(item.threadId);
    return state &&
      state.threadFeedId === item.threadFeedId &&
      groupRequestNotificationChanged(previous.get(state.threadId), state) &&
      (state.joinRequestReadFeedId >= 0 ||
        (previous.get(state.threadId)?.joinRequestReadFeedId ?? -1) >= 0)
      ? [state]
      : [];
  });
  const settings = await requestNotificationSettings(preferences, copy.lang);
  const rows = await storage.getThreads();
  const requestDescriptors = requests.flatMap((state) => {
    const row = rows.find((item) => item.threadId === state.threadId);
    if (!row) return [];
    const descriptor = groupRequestNotification(
      state,
      state.alias || row.profile.name || row.account,
      settings,
      row.muted,
    );
    const before = previous.get(state.threadId);
    descriptor.updateExistingOnly =
      !before || state.joinRequestEndFeedId <= before.joinRequestEndFeedId;
    descriptor.silent ||= descriptor.updateExistingOnly;
    return [descriptor];
  });
  return [
    ...(await projectNotificationThreads(
      storage,
      userId,
      preferences,
      copy,
      selected,
    )),
    ...requestDescriptors,
  ];
}

/** Call only with the complete state read after a successful fetch/merge, under
 * restoration exclusion. An incremental page is not a complete reconstruction. */
export async function projectNotificationReconstruction(
  storage: WebdbStorage,
  userId: number,
  preferences: Pick<PreferenceStorage, 'get'>,
  copy: Parameters<typeof threadNotificationDescriptor>[2],
  mergedStates: readonly LocalThreadAttention[],
): Promise<NotificationDescriptor[]> {
  const [settings, rows] = await Promise.all([
    requestNotificationSettings(preferences, copy.lang),
    storage.getThreads(),
  ]);
  const requests = mergedStates.flatMap((state) => {
    const row = rows.find((item) => item.threadId === state.threadId);
    return row && state.joinRequestReadFeedId >= 0
      ? [
          groupRequestNotification(
            state,
            state.alias || row.profile.name || row.account,
            settings,
            row.muted,
          ),
        ]
      : [];
  });
  return [
    ...(await projectNotificationThreads(
      storage,
      userId,
      preferences,
      copy,
      mergedStates,
    )),
    ...requests,
  ];
}

/** Shared content projection; selection belongs to the explicit callers above. */
async function projectNotificationThreads(
  storage: WebdbStorage,
  userId: number,
  preferences: Pick<PreferenceStorage, 'get'>,
  copy: Parameters<typeof threadNotificationDescriptor>[2],
  states: readonly LocalThreadAttention[],
): Promise<NotificationDescriptor[]> {
  const notifications: NotificationDescriptor[] = [];
  const [rows, self, enabled, sound, mode] = await Promise.all([
    storage.getThreads(),
    storage.readAccountState().then((state) => state.selfProfile),
    preferences.get<boolean>('device', 'notificationEnabled'),
    preferences.get<boolean>('device', 'notificationSound'),
    preferences.get<string>('device', 'notificationPreviewMode'),
  ]);
  const owner = self;
  for (const state of states) {
    const snapshot = attentionSnapshot(state);
    if (!snapshot) continue;
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
    const [binding] = await storage.getProfileNamespaceBindings([
      {
        publisherNamespaceId: 0,
        profileNamespaceId: item.publisherNamespaceId,
      },
    ]);
    const descriptor = threadNotificationDescriptor(
      {
        item: {
          ...item,
          lastReadSeq: projection.lastReadSeq,
          unreadCount: projection.unreadCount,
          mentionUnread: projection.hasUnreadMention ? ['me'] : [],
        },
        state: snapshot,
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
  return notifications;
}
