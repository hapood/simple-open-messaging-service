import { openDB, type DBSchema } from 'idb';

const DB_NAME = 'soms-notification-checkpoint';
const STORE_NAME = 'state';
const CURSOR_KEY = 'thread-feed-since';

interface NotificationCheckpointDb extends DBSchema {
  state: {
    key: string;
    value: number;
  };
}

const database = openDB<NotificationCheckpointDb>(DB_NAME, 2, {
  upgrade(db) {
    if (db.objectStoreNames.contains(STORE_NAME))
      db.deleteObjectStore(STORE_NAME);
    db.createObjectStore(STORE_NAME);
  },
});

export async function readNotificationSince(
  stream: 'thread' | 'state' = 'thread',
): Promise<number> {
  return (
    (await (
      await database
    ).get(STORE_NAME, stream === 'state' ? 'state-feed-since' : CURSOR_KEY)) ??
    0
  );
}

/** Monotonic checkpoint shared by the browser page and its Push service worker. */
export async function advanceNotificationSince(
  feedId: number,
  stream: 'thread' | 'state' = 'thread',
): Promise<void> {
  const key = stream === 'state' ? 'state-feed-since' : CURSOR_KEY;
  if (!Number.isSafeInteger(feedId) || feedId < 0) return;
  const db = await database;
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const current = (await tx.store.get(key)) ?? 0;
  if (feedId > current) await tx.store.put(feedId, key);
  await tx.done;
}

/** Reset account-scoped notification state when the browser session logs out or switches account. */
export async function resetNotificationSince(): Promise<void> {
  await (await database).clear(STORE_NAME);
}
