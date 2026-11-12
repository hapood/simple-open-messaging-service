import type { WebdbStorage } from './webdb-storage';
import type { PreferenceStorage } from './preference-storage';
import { synchronizeStateFeed } from './worker-state-feed-sync';
import {
  friendRequestNotification,
  friendRequestNotificationChanged,
  requestNotificationSettings,
} from './request-notification';
import type { NotificationDescriptor } from './notification-descriptor.model';

/** Personal requests are projected from authoritative account markers, independently of messages. */
export async function syncPushState(
  storage: Pick<WebdbStorage, 'readAccountState' | 'applyStateFeedPage'> &
    Partial<Pick<WebdbStorage, 'withStateFeedLock'>>,
  target: number,
  request: Parameters<typeof synchronizeStateFeed>[2],
  preferences: Pick<PreferenceStorage, 'get'>,
  language: string,
): Promise<{
  cursor: number;
  notifications: NotificationDescriptor[];
  error?: unknown;
}> {
  const run = async () => {
    const before = await storage.readAccountState();
    let error: unknown;
    try {
      await synchronizeStateFeed(storage, target, request);
    } catch (failure) {
      error = failure;
    }
    const after = await storage.readAccountState();
    const notifications: NotificationDescriptor[] = [];
    // A first full snapshot is a baseline, not a delivery of historical arrivals.
    if (
      before.intentRequestEndId !== null &&
      friendRequestNotificationChanged(before, after)
    ) {
      const descriptor = friendRequestNotification(
        after,
        await requestNotificationSettings(preferences, language),
      );
      descriptor.updateExistingOnly =
        BigInt(after.intentRequestEndId ?? '0') <=
        BigInt(before.intentRequestEndId);
      descriptor.silent ||= descriptor.updateExistingOnly;
      notifications.push(descriptor);
    }
    return {
      cursor: after.stateFeedId ?? 0,
      notifications,
      ...(error ? { error } : {}),
    };
  };
  return storage.withStateFeedLock ? storage.withStateFeedLock(run) : run();
}
