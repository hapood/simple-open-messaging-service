import type {
  LocalThreadAttention,
  ThreadFeedSnapshot,
} from '../../../../shared/thread-attention';

export interface ThreadFeedSyncResult {
  states: LocalThreadAttention[];
  cursor: number;
  error?: string;
}

export interface ThreadFeedSyncStorage {
  withThreadFeedLock?<T>(run: () => Promise<T>): Promise<T>;
  getMeta(key: string): Promise<unknown>;
  mergeThreadStates(
    states: ThreadFeedSnapshot[],
    cursor: number,
  ): Promise<LocalThreadAttention[]>;
}

/** Coalesce queued wakes; failures only run again when another wake has actually arrived. */
export function coalesceThreadFeedWakes(
  enqueue: (task: () => Promise<void>) => void,
  run: (target: number) => Promise<void>,
): (target: number) => void {
  let highest = 0;
  let pending = false;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    enqueue(async () => {
      pending = false;
      try {
        await run(highest);
      } finally {
        scheduled = false;
        if (pending) schedule();
      }
    });
  };
  return (target) => {
    if (!Number.isInteger(target) || target < 0 || target > 2147483647) return;
    highest = Math.max(highest, target);
    pending = true;
    schedule();
  };
}

/** Runs in the database worker. Committed pages remain deliverable if a later request fails. */
export async function syncThreadFeed(
  storage: ThreadFeedSyncStorage,
  target: number,
  request: (body: {
    after: number;
    through: number;
    take: number;
    previewCount: number;
  }) => Promise<unknown>,
  previewCount: 1 | 5 = 1,
): Promise<ThreadFeedSyncResult> {
  const run = () => syncThreadFeedUnlocked(storage, target, request, previewCount);
  return storage.withThreadFeedLock ? storage.withThreadFeedLock(run) : run();
}

async function syncThreadFeedUnlocked(
  storage: ThreadFeedSyncStorage,
  target: number,
  request: Parameters<typeof syncThreadFeed>[2],
  previewCount: 1 | 5,
): Promise<ThreadFeedSyncResult> {
  if (previewCount !== 1 && previewCount !== 5)
    throw new Error('invalid thread feed preview count');
  const initial = (await storage.getMeta('threadFeedCursor')) ?? 0;
  if (
    !Number.isInteger(initial) ||
    Number(initial) < 0 ||
    Number(initial) > 2147483647
  )
    throw new Error('invalid local thread feed cursor');
  if (!Number.isInteger(target) || target < 0 || target > 2147483647)
    throw new Error('invalid thread feed target');
  let cursor = Number(initial);
  const states = new Map<number, LocalThreadAttention>();
  try {
    while (cursor < target) {
      const through = target;
      const response = (await request({
        after: cursor,
        through,
        take: 100,
        previewCount,
      })) as {
        code: number;
        data?: {
          items: ThreadFeedSnapshot[];
          scannedThrough: number;
          through: number;
          threadFeedEndId: number;
          hasMore: boolean;
        };
      };
      const page = response?.data;
      if (response?.code !== 0 || !page)
        throw new Error('thread feed query failed');
      if (
        page.through !== through ||
        !Number.isInteger(page.scannedThrough) ||
        page.scannedThrough <= cursor ||
        page.scannedThrough > through ||
        !Number.isInteger(page.threadFeedEndId) ||
        page.threadFeedEndId < through ||
        page.threadFeedEndId > 2147483647 ||
        typeof page.hasMore !== 'boolean' ||
        (!page.hasMore && page.scannedThrough !== through) ||
        !Array.isArray(page.items)
      )
        throw new Error('invalid thread feed page boundary');
      let previous = cursor;
      for (const state of page.items) {
        if (
          !Number.isInteger(state.threadFeedId) ||
          state.threadFeedId <= previous ||
          state.threadFeedId > page.scannedThrough
        )
          throw new Error('unordered thread feed page');
        previous = state.threadFeedId;
      }
      for (const state of await storage.mergeThreadStates(
        page.items,
        page.scannedThrough,
      ))
        states.set(state.threadId, state);
      cursor = page.scannedThrough;
      target = Math.max(target, page.threadFeedEndId);
    }
    return { states: [...states.values()], cursor };
  } catch (error) {
    return {
      states: [...states.values()],
      cursor,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
