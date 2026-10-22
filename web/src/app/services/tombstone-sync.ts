import type { DeletedMessageItem } from './model';

const CLIENT_FEED_CURSOR_UNAVAILABLE = 30006;

export interface TombstoneSyncStorage {
  getDeletedHwm(threadId: number): Promise<number>;
  applyDeletedMessages(
    threadId: number,
    items: DeletedMessageItem[],
    hwm: number,
  ): Promise<void>;
}

export interface TombstonePage {
  tombstones: DeletedMessageItem[];
  scannedThrough: number;
  hasMore: boolean;
}

export interface TombstoneRequest {
  threadId: number;
  after: number;
  take: number;
  through: number;
  maxMessageSeq?: number;
}

export type TombstoneRequester = (request: TombstoneRequest) => Promise<unknown>;

interface TombstoneEnvelope {
  code?: unknown;
  data?: unknown;
}

interface TombstonePageData {
  tombstones?: unknown;
  scannedThrough?: unknown;
  hasMore?: unknown;
}

function pageFrom(value: unknown): TombstonePageData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as TombstonePageData;
}

/**
 * Drain the deletion (tombstone) feed for one thread up to `target`.
 *
 * Mirrors the per-thread structure of {@link syncGroupMetaThread}: page loop,
 * HWM-monotonic commit, one optional `guard()` between pages so the caller can
 * stop after the current page commits when the thread is no longer open.
 */
export async function syncTombstoneThread(
  storage: TombstoneSyncStorage,
  request: TombstoneRequester,
  threadId: number,
  target: number,
  recovery?: { through: number; maxMessageSeq: number },
  guard?: () => boolean,
): Promise<DeletedMessageItem[]> {
  const committed: DeletedMessageItem[] = [];
  let hwm = await storage.getDeletedHwm(threadId);
  let recoveryState = recovery;
  for (;;) {
    if (guard && !guard()) return committed;
    const currentTarget = recoveryState?.through ?? target;
    if (hwm >= currentTarget) {
      if (recoveryState) {
        recoveryState = undefined;
        continue;
      }
      return committed;
    }
    const envelope = (await request({
      threadId,
      after: hwm,
      take: 100,
      through: currentTarget,
      ...(recoveryState ? { maxMessageSeq: recoveryState.maxMessageSeq } : {}),
    })) as TombstoneEnvelope;
    if (envelope?.code === CLIENT_FEED_CURSOR_UNAVAILABLE) {
      // Server-directed recovery window. Reset HWM and retry once.
      // The browser endpoint currently returns a plain page; this branch keeps
      // the contract symmetric with group-meta for a future server change.
      throw new Error('tombstone recovery window is unavailable');
    }
    const data = envelope?.code === 0 ? pageFrom(envelope.data) : null;
    if (!data)
      throw new Error(
        `tombstone query failed (code ${String(envelope?.code)})`,
      );
    if (
      !Array.isArray(data.tombstones) ||
      !Number.isSafeInteger(data.scannedThrough) ||
      typeof data.hasMore !== 'boolean'
    )
      throw new Error('tombstone query returned an invalid page');
    const page = data as TombstonePage;
    if (
      page.scannedThrough < hwm ||
      (page.scannedThrough === hwm && page.hasMore)
    )
      throw new Error('tombstone query returned an invalid boundary');
    await storage.applyDeletedMessages(threadId, page.tombstones, page.scannedThrough);
    committed.push(...page.tombstones);
    hwm = page.scannedThrough;
    if (!page.hasMore) {
      if (recoveryState) {
        recoveryState = undefined;
        continue;
      }
      return committed;
    }
  }
}
