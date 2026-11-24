import type { DeletedMessageItem } from './model';

const CLIENT_FEED_CURSOR_UNAVAILABLE = 30006;

export interface TombstoneSyncStorage {
  getDeletedHwm(threadId: number): Promise<number>;
  /** Current actual stored message maximum, independent of the head tuple. */
  getTombstoneCutoff(threadId: number): Promise<number>;
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
  maxMessageSeq: number;
}

export type TombstoneRequester = (
  request: TombstoneRequest,
) => Promise<unknown>;

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

export interface TombstonePageResult {
  status: 'DONE' | 'MORE' | 'CUTOFF_STALLED';
  committed: DeletedMessageItem[];
  hwm: number;
  cutoff: number;
  target: number;
}

/**
 * Execute one tombstone page round for `threadId` up to `target`.
 */
export async function syncTombstonePage(
  storage: TombstoneSyncStorage,
  request: TombstoneRequester,
  threadId: number,
  target: number,
): Promise<TombstonePageResult> {
  const hwm = await storage.getDeletedHwm(threadId);
  if (!Number.isSafeInteger(hwm) || hwm < 0)
    throw new Error('missing or invalid deleted-message HWM');
  if (!Number.isSafeInteger(target) || target < 0)
    throw new Error('invalid tombstone target');
  const cutoff = await storage.getTombstoneCutoff(threadId);
  if (!Number.isSafeInteger(cutoff) || cutoff < 0)
    throw new Error('invalid tombstone message cutoff');
  if (hwm >= target) {
    return { status: 'DONE', committed: [], hwm, cutoff, target };
  }
  if (cutoff === 0) {
    return { status: 'CUTOFF_STALLED', committed: [], hwm, cutoff, target };
  }
  const envelope = (await request({
    threadId,
    after: hwm,
    take: 50,
    through: target,
    maxMessageSeq: cutoff,
  })) as TombstoneEnvelope;
  if (envelope?.code === CLIENT_FEED_CURSOR_UNAVAILABLE) {
    // A missing server cursor is an error, never permission to reset progress.
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
    page.scannedThrough > target ||
    (page.scannedThrough === hwm && page.hasMore)
  )
    throw new Error('tombstone query returned an invalid boundary');
  let applied = hwm;
  for (const item of page.tombstones) {
    if (
      item.threadId !== threadId ||
      !Number.isSafeInteger(item.deletionSeq) ||
      item.deletionSeq <= applied ||
      item.deletionSeq > page.scannedThrough ||
      !Number.isSafeInteger(item.messageSeq) ||
      item.messageSeq < 1 ||
      item.messageSeq > cutoff
    )
      throw new Error('tombstone query returned invalid facts');
    applied = item.deletionSeq;
  }
  // An exhausted cutoff is not applied progress, even if the source scanned ahead.
  if (applied === hwm) {
    return { status: 'CUTOFF_STALLED', committed: [], hwm, cutoff, target };
  }
  await storage.applyDeletedMessages(threadId, page.tombstones, applied);
  return {
    status: page.hasMore ? 'MORE' : 'DONE',
    committed: page.tombstones,
    hwm: applied,
    cutoff,
    target,
  };
}

/**
 * Drain the deletion (tombstone) feed for one thread up to `target`.
 */
export async function syncTombstoneThread(
  storage: TombstoneSyncStorage,
  request: TombstoneRequester,
  threadId: number,
  target: number,
  _recovery?: { through: number; maxMessageSeq: number },
  onCommitted?: (items: DeletedMessageItem[]) => void,
): Promise<DeletedMessageItem[]> {
  const committed: DeletedMessageItem[] = [];
  for (;;) {
    const result = await syncTombstonePage(storage, request, threadId, target);
    if (result.committed.length > 0) {
      committed.push(...result.committed);
      onCommitted?.(result.committed);
    }
    if (result.status !== 'MORE') return committed;
  }
}
