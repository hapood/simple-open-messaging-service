import type { ClientStateFeedItem } from './user.service';
import type { WebdbStorage } from './webdb-storage';

type Storage = Pick<WebdbStorage, 'readAccountState' | 'applyStateFeedPage'>;
type Page = {
  mode: 'full' | 'delta';
  items: ClientStateFeedItem[];
  scannedThrough: number;
  stateFeedEndId: number;
  hasMore: boolean;
};
type Envelope = {
  code: number;
  data?: Page | { resumeAfter: number; resumeBefore: number };
};

type Query = {
  mode: 'full' | 'delta';
  after: number;
  through: number;
  take: number;
};

function safeCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validate(
  page: Page,
  mode: Query['mode'],
  after: number,
  through: number,
): void {
  if (
    page.mode !== mode ||
    !Array.isArray(page.items) ||
    !safeCursor(page.scannedThrough) ||
    page.scannedThrough <= after ||
    page.scannedThrough > through ||
    !safeCursor(page.stateFeedEndId) ||
    page.stateFeedEndId < page.scannedThrough ||
    typeof page.hasMore !== 'boolean' ||
    (page.hasMore && page.scannedThrough >= through) ||
    page.items.some(
      (item, index) =>
        !safeCursor(item.feedId) ||
        item.feedId <= after ||
        item.feedId > page.scannedThrough ||
        (index > 0 && item.feedId <= page.items[index - 1].feedId),
    )
  )
    throw new Error('invalid state-feed page');
}

/** The database worker owns the browser state-feed cursor, full-snapshot recovery and page commits. */
export async function synchronizeStateFeed(
  storage: Storage,
  wake: number,
  request: (query: Query) => Promise<Envelope>,
): Promise<number> {
  if (!safeCursor(wake)) throw new Error('invalid state-feed target');
  const state = await storage.readAccountState();
  const persisted = state.stateFeedId ?? undefined;
  if (persisted !== undefined && !safeCursor(persisted))
    throw new Error('invalid state-feed cursor');
  let after = persisted === undefined ? 0 : persisted;
  const boundary = state.stateFeedFullThrough ?? undefined;
  if (boundary !== undefined && (!safeCursor(boundary) || boundary <= after))
    throw new Error('invalid state-feed full boundary');
  let target = Math.max(
    wake,
    boundary === undefined ? 0 : (boundary as number),
  );
  let fullThrough =
    boundary === undefined
      ? after === 0 && target > 0
        ? target
        : undefined
      : (boundary as number);
  let reset = after === 0 && fullThrough !== undefined;
  let recovered = false;
  while (after < target) {
    const through = fullThrough ?? target;
    const mode = fullThrough === undefined ? 'delta' : 'full';
    const envelope = await request({ mode, after, through, take: 100 });
    if (envelope.code === 30006) {
      if (recovered) throw new Error('state-feed recovery did not progress');
      const window = envelope.data as
        | { resumeAfter?: unknown; resumeBefore?: unknown }
        | undefined;
      if (
        !safeCursor(window?.resumeAfter) ||
        !safeCursor(window?.resumeBefore) ||
        window.resumeBefore <= window.resumeAfter
      )
        throw new Error('invalid state-feed recovery window');
      after = window.resumeAfter;
      target = window.resumeBefore - 1;
      fullThrough = target > after ? target : undefined;
      reset = true;
      recovered = true;
      if (target === after)
        await storage.applyStateFeedPage([], after, true, null);
      continue;
    }
    if (envelope.code !== 0 || !envelope.data)
      throw new Error(`state-feed response ${envelope.code}`);
    const page = envelope.data as Page;
    validate(page, mode, after, through);
    const nextFull =
      fullThrough === undefined
        ? undefined
        : page.scannedThrough < fullThrough
          ? fullThrough
          : null;
    await storage.applyStateFeedPage(
      page.items,
      page.scannedThrough,
      reset,
      nextFull,
    );
    after = page.scannedThrough;
    reset = false;
    if (fullThrough !== undefined && after >= fullThrough)
      fullThrough = undefined;
    target = Math.max(target, page.stateFeedEndId);
    if (!page.hasMore && after < through)
      throw new Error('state-feed response ended before requested boundary');
  }
  return after;
}
