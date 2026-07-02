/**
 * ChatBoxScroller (Plan B · array index) unit tests.
 *
 * The kernel is framework-agnostic and only interacts via the CbElement + CbSource interfaces, so the tests drive it
 * with mocks:
 *  - controllableHooks: a real div + Object.defineProperty(offsetHeight), createItem(item, prev).
 *  - fakeSource: N msgs ('m-0' oldest .. 'm-(N-1)' newest), cursor getOlder/getNewer, ascending return.
 * content.scrollHeight / viewport.clientHeight / scrollTop are fixed via getter/setter; RAF is mocked synchronous.
 *
 * Focus: Plan B scrollTop compensation (viewport does not jump after loadOlder prepend), ghost rebuild (createItem
 * re-invoked with the new prev), and phase-0 noOlder absorb timing. The msgId cursor verifies that the kernel index is
 * decoupled from the source id.
 */
import { ChatBoxScroller, CbElement, CbItem } from './chat-box-scroller';
import type { CbSource } from './cb-source';

/** 'm-K' → K (parse a msgId to its index). */
function num(id: string | number): number { return Number(String(id).replace(/^m-/, '')); }

function sumChildrenHeight(el: HTMLElement): number {
  let s = 0;
  for (const c of Array.from(el.children)) s += (c as HTMLElement).offsetHeight || 0;
  return s;
}

/** Controllable hooks: createItem(item, prev), fixed height per item (mutable later via setHeight). msgId is the Map key. */
function controllableHooks(itemHeight = 100): {
  hooks: { createItem: (item: CbItem<number>, prev: CbItem<number> | null) => CbElement<number> };
  setHeight: (id: string, h: number) => void;
} {
  const cbs = new Map<string, (h: number) => void>();
  const heights = new Map<string, number>();
  const h0 = (id: string) => heights.get(id) ?? itemHeight;
  return {
    hooks: {
      createItem: (item): CbElement<number> => {
        const id = String(item.id);
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => h0(id) });
        return {
          el,
          onHeightChange: (cb) => { cbs.set(id, cb); return () => { cbs.delete(id); }; },
          update: () => {},
          destroy: () => {},
        };
      },
    },
    setHeight: (id: string, h: number) => { heights.set(id, h); cbs.get(id)?.(h); },
  };
}

/** Hooks that record each createItem's (id, prev.id) — verifies ghost rebuild re-invokes createItem with the new prev. */
function recordingHooks(itemHeight = 100): {
  hooks: { createItem: (item: CbItem<number>, prev: CbItem<number> | null) => CbElement<number> };
  calls: { id: string; prev: string | null }[];
} {
  const calls: { id: string; prev: string | null }[] = [];
  return {
    hooks: {
      createItem: (item, prev): CbElement<number> => {
        const id = String(item.id);
        calls.push({ id, prev: prev ? String(prev.id) : null });
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => itemHeight });
        return { el, onHeightChange: () => () => {}, update: () => {}, destroy: () => {} };
      },
    },
    calls,
  };
}

/** Hooks that record createItem vs update so reconcilePending tests can assert in-place morph (update, NOT recreate).
 *  Tracks the latest data applied per id through EITHER path (create or update). Fixed height (no morph delta). */
function trackingHooks(itemHeight = 100): {
  hooks: { createItem: (item: CbItem<number>, prev: CbItem<number> | null) => CbElement<number> };
  createCount: () => number;
  updateCount: () => number;
  dataOf: (id: string) => number;
} {
  let creates = 0;
  let updates = 0;
  const dataMap = new Map<string, number>();
  return {
    hooks: {
      createItem: (item): CbElement<number> => {
        creates++;
        const id = String(item.id);
        dataMap.set(id, item.data);
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => itemHeight });
        return {
          el,
          onHeightChange: () => () => {},
          update: (next) => { updates++; dataMap.set(id, next.data); },
          destroy: () => {},
        };
      },
    },
    createCount: () => creates,
    updateCount: () => updates,
    dataOf: (id) => dataMap.get(id) ?? -1,
  };
}

/** fakeSource with a mutable pending array the test mutates to simulate MockItemSource.failPending/retryPending. */
function pendingSource(total: number, pending: CbItem<number>[]): CbSource<number> {
  return { ...fakeSource(total), getPending: () => pending.slice() };
}

/** Fake source: N msgs ('m-0' oldest .. 'm-(N-1)' newest). Cursor getOlder/getNewer, ascending return. */
function fakeSource(N: number): CbSource<number> & { gets: () => number; newers: () => number } {
  const itemAt = (i: number): CbItem<number> | undefined => {
    if (i < 0 || i >= N) return undefined;
    const boundary = i === 0 ? 'oldest' as const : i === N - 1 ? 'newest' as const : undefined;
    return boundary ? { id: `m-${i}`, data: i, boundary } : { id: `m-${i}`, data: i };
  };
  const slice = (lo: number, hi: number): CbItem<number>[] => {
    const out: CbItem<number>[] = [];
    for (let i = Math.max(0, lo); i < Math.min(N, hi); i++) { const it = itemAt(i); if (it) out.push(it); }
    return out;
  };
  let gets = 0;
  let newers = 0;
  const src: CbSource<number> = {
    init: async (anchorId, older, newer) => {
      if (anchorId === -1) return slice(N - older, N); // anchor = newest
      const idx = num(anchorId); // real msgId: bidirectional fetch (mirrors MockItemSource)
      if (idx < 0 || idx >= N) return [];
      const olderStart = Math.max(0, idx - older + 1);
      const newerEnd = Math.min(N, idx + 1 + newer);
      return [...slice(olderStart, idx + 1), ...slice(idx + 1, newerEnd)];
    },
    getOlder: async (cursorId, count) => { gets++; const k = num(cursorId); return slice(k - count, k); },
    getNewer: async (cursorId, count) => { newers++; const k = num(cursorId); return slice(k + 1, k + 1 + count); },
    pushLive: (_items) => { /* cache-only: direct-mount path mounts the raw items; the signal path uses getNewer */ },
    getPending: () => [],
    destroy: () => {},
  };
  return Object.assign(src, { gets: () => gets, newers: () => newers });
}

/** Controllable-init source: init returns a manually-resolved Promise (tests consecutive-jump gen overtake: in-flight jump dropped). */
function controllableInitSource(N: number): CbSource<number> & {
  resolveInit: (items: CbItem<number>[]) => void; initPending: () => number; batchAround: (k: number) => CbItem<number>[];
} {
  const itemAt = (i: number): CbItem<number> | undefined => {
    if (i < 0 || i >= N) return undefined;
    const boundary = i === 0 ? 'oldest' as const : i === N - 1 ? 'newest' as const : undefined;
    return boundary ? { id: `m-${i}`, data: i, boundary } : { id: `m-${i}`, data: i };
  };
  const slice = (lo: number, hi: number): CbItem<number>[] => {
    const out: CbItem<number>[] = [];
    for (let i = Math.max(0, lo); i < Math.min(N, hi); i++) { const it = itemAt(i); if (it) out.push(it); }
    return out;
  };
  const queue: ((items: CbItem<number>[]) => void)[] = [];
  const src: CbSource<number> = {
    init: () => new Promise<CbItem<number>[]>(resolve => { queue.push(resolve); }),
    getOlder: async (c, k) => { const i = num(c); return slice(i - k, i); },
    getNewer: async (c, k) => { const i = num(c); return slice(i + 1, i + 1 + k); },
    pushLive: (_items) => { /* cache-only: direct-mount path mounts the raw items; the signal path uses getNewer */ },
    getPending: () => [],
    destroy: () => {},
  };
  return Object.assign(src, {
    resolveInit: (items: CbItem<number>[]) => { const r = queue.shift(); if (r) r(items); },
    initPending: () => queue.length,
    batchAround: (k: number) => [...slice(Math.max(0, k - 49), k + 1), ...slice(k + 1, k + 51)],
  });
}

/** Controllable source: getOlder returns a manually-resolved Promise, to test changing scrollTop while getOlder is in flight (reverse fling). */
function controllableSource(N: number): CbSource<number> & {
  gets: () => number; resolveOlder: (items?: CbItem<number>[]) => void; isPending: () => boolean;
} {
  const itemAt = (i: number): CbItem<number> | undefined => {
    if (i < 0 || i >= N) return undefined;
    const boundary = i === 0 ? 'oldest' as const : i === N - 1 ? 'newest' as const : undefined;
    return boundary ? { id: `m-${i}`, data: i, boundary } : { id: `m-${i}`, data: i };
  };
  const slice = (lo: number, hi: number): CbItem<number>[] => {
    const out: CbItem<number>[] = [];
    for (let i = Math.max(0, lo); i < Math.min(N, hi); i++) { const it = itemAt(i); if (it) out.push(it); }
    return out;
  };
  let resolver: ((items?: CbItem<number>[]) => void) | null = null;
  let pendingRange = { lo: 0, hi: 0 };
  let gets = 0;
  const src: CbSource<number> = {
    init: async (_r, older) => slice(N - older, N),
    getOlder: function (cursorId: string | number, count: number): Promise<CbItem<number>[]> {
      gets++; const k = num(cursorId); pendingRange = { lo: k - count, hi: k };
      return new Promise(resolve => { resolver = (items?: CbItem<number>[]) => resolve(items ?? slice(pendingRange.lo, pendingRange.hi)); });
    },
    getNewer: async (cursorId, count) => { const k = num(cursorId); return slice(k + 1, k + 1 + count); },
    pushLive: (_items) => { /* cache-only: direct-mount path mounts the raw items; the signal path uses getNewer */ },
    getPending: () => [],
    destroy: () => {},
  };
  return Object.assign(src, {
    gets: () => gets,
    resolveOlder: (items?: CbItem<number>[]) => { if (resolver) { const r = resolver; resolver = null; r(items); } },
    isPending: () => resolver !== null,
  });
}

/** Drain microtasks (openAround/fillAround multi-hop async await): scrollToIndex is fire-and-forget, so flush manually. */
async function flush(n = 30): Promise<void> { for (let i = 0; i < n; i++) await Promise.resolve(); }

/** Replace the viewport's fixed clientHeight getter with a mutable one (simulate a viewport shrink/grow, e.g. the soft
 *  keyboard opening/closing). Returns a setter. */
function mutableVh(viewport: HTMLDivElement, initial: number): { set: (v: number) => void } {
  let v = initial;
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => v });
  return { set: (nv: number) => { v = nv; } };
}

/** Test seam: invoke the private viewport-resize handler directly (ResizeObserver cannot be driven from a getter-based
 *  clientHeight in the jsdom/Karma layout, so drive the handler the RO callback would call). */
function reflow(s: ChatBoxScroller<number>): void { (s as unknown as { onViewportResize: () => void }).onViewportResize(); }

describe('ChatBoxScroller (Plan B · array index)', () => {
  let viewport: HTMLDivElement;
  let content: HTMLDivElement;
  let scroller: ChatBoxScroller<number> | undefined;
  let rafSpy: jasmine.Spy;
  let savedNgDev: unknown;

  beforeEach(() => {
    viewport = document.createElement('div');
    content = document.createElement('div');
    viewport.appendChild(content);
    document.body.appendChild(viewport);
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 600 });
    let st = 0;
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => st, set: (v: number) => { st = v; } });
    Object.defineProperty(content, 'scrollHeight', { configurable: true, get: () => sumChildrenHeight(content) });
    rafSpy = spyOn(window, 'requestAnimationFrame').and.callFake((cb: FrameRequestCallback) => { cb(0); return 0; });
    savedNgDev = (globalThis as { ngDevMode?: unknown }).ngDevMode;
    (globalThis as { ngDevMode?: unknown }).ngDevMode = true;
  });

  afterEach(() => {
    scroller?.destroy();
    scroller = undefined;
    viewport.remove();
    rafSpy.and.callThrough?.();
    (globalThis as { ngDevMode?: unknown }).ngDevMode = savedNgDev;
  });

  it('init loads the newest batch, pins to bottom, window boundary msgIds correct', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const info = scroller.getInfo();
    expect(info.mounted).toBe(100);
    expect(info.oldestId).toBe('m-400');
    expect(info.newestId).toBe('m-499');
    expect(info.atBottom).toBe(true);
    expect(info.noNewer).toBe(true);  // boundary newest absorbed (anchor)
    expect(info.noOlder).toBe(false); // not yet at the oldest
  });

  it('scrolling to the top edge → loadOlder triggers getOlder, mounts older, oldestId moves older', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    const oldestBefore = scroller.getInfo().oldestId!;
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    await Promise.resolve();
    expect(src.gets()).toBeGreaterThan(0);
    // older mounted: oldestId index is smaller (older); after trim the window may scroll further, so oldestId can be even older
    expect(num(scroller.getInfo().oldestId!)).toBeLessThanOrEqual(num(oldestBefore));
  });

  it('Plan B: scrollTop compensation after loadOlder (viewport does not jump)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    viewport.scrollTop = 50;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    await Promise.resolve();
    // loadOlder prepends above the viewport → scrollTop must be += the mounted height (> 50, not 0)
    expect(viewport.scrollTop).toBeGreaterThan(50);
  });

  it('after reaching the oldest boundary, further up-scroll → no more getOlder (noOlder breaker)', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(120); // only 120 items: init 100 + one fill batch reaches the oldest
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    for (let i = 0; i < 5; i++) {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event('scroll'));
      await Promise.resolve(); await Promise.resolve();
    }
    expect(scroller.getInfo().noOlder).toBe(true);
    const getsAtBoundary = src.gets();
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve(); await Promise.resolve();
    expect(src.gets()).toBe(getsAtBoundary);
  });

  it('appendLive (WS) mounts at the bottom and follows', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    scroller.appendLive([{ id: 'x', data: -1 }]);
    await Promise.resolve();
    const info = scroller.getInfo();
    expect(info.newestId).toBe('x');
    expect(info.atBottom).toBe(true);
  });

  it('trim: repeated loadOlder keeps the window stable, no unbounded growth (viewport buffer preserved)', async () => {
    const { hooks } = controllableHooks(); // 100px/item
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init();
    const totals: number[] = [];
    for (let i = 0; i < 10; i++) {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event('scroll'));
      await Promise.resolve(); await Promise.resolve();
      if (i >= 5) totals.push(sumChildrenHeight(content));
    }
    // trim keeps a viewport buffer (loadOlder's compensateAbove pushes st up → total ≈ st+vh+edge, > threshold 6000,
    //  not "just past threshold"). Core goal: repeated loadOlder is stable, no unbounded growth (last < threshold*3,
    //  last-5 spread < 500).
    expect(totals[totals.length - 1]).toBeLessThan(6000 * 3);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThan(500);
  });

  it('measurePending removes cb-pending from mounted elements', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(content.querySelectorAll('.cb-pending').length).toBe(0);
  });

  // ── Phase 0: noOlder absorb timing (absorbed only after revalidate passes, preventing a fling-back from falsely locking) ──

  it('phase 0: a batch containing the oldest boundary is not mounted on reverse fling → noOlder not locked, getOlder still works back at top', async () => {
    const { hooks } = controllableHooks();
    const src = controllableSource(120); // init 100 → first getOlder returns m-0..m-19 (contains oldest m-0)
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    expect(scroller.getInfo().noOlder).toBe(false);

    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    expect(src.isPending()).toBe(true);

    // reverse fling: leave the top edge (> edge=1000) + scrollDir becomes down
    viewport.scrollTop = 2000;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve();

    src.resolveOlder();
    await Promise.resolve();
    expect(scroller.getInfo().noOlder).toBe(false); // before the fix this was locked to true (bug)

    const getsBefore = src.gets();
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    expect(src.gets()).toBeGreaterThan(getsBefore);
  });

  // ── Phase 1: skeleton item (cb-ghost + rebuild) ──

  it('phase 1: after init the top mounted[0] shows cb-ghost (not yet at oldest), exactly one', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const oldest = scroller.getInfo().oldestId!;
    expect(content.querySelector(`[data-cb-id="${oldest}"]`)?.classList.contains('cb-ghost')).toBe(true);
    expect(content.querySelectorAll('.cb-ghost').length).toBe(1);
  });

  it('phase 1: scrolling to the global oldest (noOlder) → cb-ghost disappears', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(120) });
    await scroller.init();
    for (let i = 0; i < 6; i++) {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event('scroll'));
      await Promise.resolve(); await Promise.resolve();
    }
    expect(scroller.getInfo().noOlder).toBe(true);
    expect(content.querySelectorAll('.cb-ghost').length).toBe(0);
  });

  it('phase 1: loadOlder mounts an older neighbor → the old ghost rebuilds (createItem re-invoked with the new prev)', async () => {
    const { hooks, calls } = recordingHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const ghostId = scroller.getInfo().oldestId!; // 'm-400': mounted with prev=null (top)
    expect(calls.filter(c => c.id === ghostId)[0].prev).toBeNull();

    // scroll up to trigger loadOlder (mount older m-300..m-399): ghostId gains an older neighbor → rebuild
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve(); await Promise.resolve();

    const forGhost = calls.filter(c => c.id === ghostId);
    expect(forGhost.length).toBe(2);          // mount + rebuild
    expect(forGhost[1].prev).not.toBeNull();   // new prev = the older neighbor
  });

  it('loadOlder trims the newest end → noNewer resets to false (loadNewer can load it back; fixes downward-scroll / pin-to-bottom stall)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(scroller.getInfo().noNewer).toBe(true); // init pinned to bottom = global newest
    // scroll up → loadOlder: prepend older + trimNewer trims the newest end (incl. the global newest m-499)
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve(); await Promise.resolve();
    expect(scroller.getInfo().noNewer).toBe(false); // trimNewer reset → loadNewer can load it back
  });

  it('destroy clears all mounted elements', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(content.children.length).toBeGreaterThan(0);
    scroller.destroy();
    expect(content.children.length).toBe(0);
  });

  // ── Jump to a specific id (scrollToIndex / init({startMsgId})): mounted positioning + unmounted re-seed + centered fill / boundary compensation ──

  it('scrollToIndex mounted → positions by anchor (top/center/bottom)', async () => {
    const { hooks } = controllableHooks(); // 100px/item
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // mounts m-400..m-499
    scroller.scrollToIndex('m-450', 'top');     // m-450 index=50 → prefix[50]=5000
    expect(viewport.scrollTop).toBe(5000);
    scroller.scrollToIndex('m-450', 'center');  // 5000 + 50 - 300
    expect(viewport.scrollTop).toBe(4750);
    scroller.scrollToIndex('m-450', 'bottom');  // 5000 + 100 - 600
    expect(viewport.scrollTop).toBe(4500);
  });

  it('init({startMsgId}) mid-history → bidirectional window around the target, centered, both sides ≥ threshold/2 (no fill)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 'm-2500', anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.oldestId).toBe('m-2451'); // older 50 (m-2451..m-2500, includes the target)
    expect(info.newestId).toBe('m-2550'); // newer 50 (m-2501..m-2550)
    expect(info.noOlder).toBe(false);
    expect(info.noNewer).toBe(false);
    expect(viewport.scrollTop).toBe(4650); // m-2500 index=49 centered: 4900+50-300
  });

  it('scrollToIndex not mounted → re-seeds the window around the id, target mounted and centered', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init(); // mounts m-4900..m-4999
    expect(scroller.getInfo().oldestId).toBe('m-4900');
    scroller.scrollToIndex('m-100', 'center'); // not mounted → async re-seed
    await flush();
    const info = scroller.getInfo();
    expect(info.oldestId).toBe('m-51');
    expect(info.newestId).toBe('m-150');
    expect(viewport.scrollTop).toBe(4650); // m-100 index=49 centered
  });

  // Regression: jumping to a NON-HEAD member of a merged album must still resolve to its album item.
  // Before the fix, openAround's hasTarget check (item.id === targetId) failed because the album item only
  // carries the head's id → early return → empty viewport. itemHasId now matches any member in CbItem.ids.
  it('scrollToIndex to a non-head album member msgId → resolves to album item, window non-empty (ids member-resolution regression)', async () => {
    const { hooks } = controllableHooks();
    // mergeItems: collapse m-10,m-11,m-12 into one album item (id=head m-10, ids=all three) — mirrors mergeAlbumItems.
    const mergeItems = (items: CbItem<number>[]): CbItem<number>[] => {
      const out: CbItem<number>[] = [];
      let i = 0;
      while (i < items.length) {
        const a = items[i], b = items[i + 1], c = items[i + 2];
        if (String(a.id) === 'm-10' && b && String(b.id) === 'm-11' && c && String(c.id) === 'm-12') {
          out.push({ ...a, ids: ['m-10', 'm-11', 'm-12'] });
          i += 3;
        } else { out.push(a); i++; }
      }
      return out;
    };
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks: { ...hooks, mergeItems }, source: fakeSource(5000) });
    await scroller.init();
    scroller.scrollToIndex('m-11', 'center'); // non-head album member → pre-fix: hasTarget=false → empty
    await flush();
    const info = scroller.getInfo();
    expect(info.mounted).toBeGreaterThan(0);               // regression: was 0 (empty viewport) before fix
    expect(num(info.oldestId as string)).toBeLessThanOrEqual(10); // window brackets the album (m-10..m-12)
    expect(num(info.newestId as string)).toBeGreaterThanOrEqual(12);
    expect(viewport.scrollTop).toBe(750);                  // album (idx 10 · topOf 1000 · h 100) centered
  });

  it('jump near oldest → noOlder, above < threshold/2 → downward compensation to threshold', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 'm-5', anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noOlder).toBe(true);
    expect(info.oldestId).toBe('m-0');
    expect(info.noNewer).toBe(false);
    expect(info.newestId).toBe('m-105'); // seed newer 50 (m-6..m-55) + compensate 50 (m-56..m-105)
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000);
  });

  it('jump near newest → noNewer, below < threshold/2 → upward compensation to threshold', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 'm-4995', anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noNewer).toBe(true);
    expect(info.newestId).toBe('m-4999');
    expect(info.noOlder).toBe(false);
    expect(info.oldestId).toBe('m-4896'); // upward compensation 50
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000);
  });

  it('tiny conversation jump → both sides at boundary, totalH < threshold, no compensation possible, render directly', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(30) });
    await scroller.init({ startMsgId: 'm-15', anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noOlder).toBe(true);
    expect(info.noNewer).toBe(true);
    expect(info.oldestId).toBe('m-0');
    expect(info.newestId).toBe('m-29');
    expect(info.mounted).toBe(30);
    expect(sumChildrenHeight(content)).toBeLessThan(6000); // below threshold, both sides at boundary, cannot compensate
  });

  it('short-item jump → fill loop fills both sides to threshold/2 (no unbounded growth)', async () => {
    const { hooks } = controllableHooks(10); // 10px/item → seed 100 items only 1000px < 3000, needs fill
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 'm-2500', anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.mounted).toBeGreaterThan(100);          // fill fired
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000); // filled to threshold
    expect(content.querySelector('[data-cb-id="m-2500"]')).toBeTruthy(); // target still in the window
  });

  it('scrollToIndex highlight → target row gets cb-jump-highlight', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    scroller.scrollToIndex('m-450', 'top', true);
    const el = content.querySelector<HTMLElement>('[data-cb-id="m-450"]');
    expect(el?.classList.contains('cb-jump-highlight')).toBe(true);
  });

  // ── Coverage: scrollToTop / refresh / loadNewer (downward load) / openAround boundary / gen overtake ──

  it('scrollToTop → scrollTop=0', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(viewport.scrollTop).toBeGreaterThan(0); // init pinned to bottom
    scroller.scrollToTop();
    expect(viewport.scrollTop).toBe(0);
  });

  it('refresh → re-measures vh + balance, no throw, window still usable', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(() => scroller!.refresh()).not.toThrow();
    // still positionable (kernel intact)
    scroller.scrollToIndex(scroller.getInfo().newestId!, 'top');
    expect(viewport.scrollTop).toBeGreaterThanOrEqual(0);
  });

  it('scrolling to the bottom edge → loadNewer triggers getNewer, mounts newer, newestId advances toward newest', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init(); // m-400..m-499 pinned to bottom, noNewer=true
    // scroll up: loadOlder → trimNewer trims the newest end → noNewer=false (loadNewer unlocked)
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    // scroll down to the bottom edge → loadNewer
    const newestBefore = num(scroller.getInfo().newestId!);
    viewport.scrollTop = content.scrollHeight - 600; // pinned to bottom
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.newers()).toBeGreaterThan(0);                       // getNewer called (loadNewer path)
    expect(num(scroller.getInfo().newestId!)).toBeGreaterThan(newestBefore); // advances toward newest
  });

  // Regression: a balance-triggered loadNewer (user scrolling to the bottom edge of a trimmed-newer window) must NOT
  // follow/chain to the global newest. Previously loadNewer did `if (wasAtBottom) scrollToBottom()`, which re-armed the
  // bottom edge and chain-jumped to the global newest ("accelerate to bottom"). Follow is now method-separated: balance
  // calls the pure loadNewer core (no follow); only scrollToBottom→followToNewest follows. Anchored at the jump-to-id
  // fix: jumping to a mid-history id lands in a trimmed-newer state, so scrolling down from there exposed this.
  it('scrolling to the bottom edge (balance) loads only one newer batch, no chain-jump to the global newest (no follow)', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init(); // m-400..m-499 pinned to bottom, noNewer=true
    // scroll up: trimNewer trims the newest end → noNewer=false (loadNewer unlocked)
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    const newestBefore = num(scroller.getInfo().newestId!);
    // scroll down to the bottom edge (balance-triggered loadNewer, NOT scrollToBottom)
    viewport.scrollTop = content.scrollHeight - 600;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.newers()).toBe(1);                                      // exactly one batch, no chain
    expect(num(scroller.getInfo().newestId!)).toBe(newestBefore + 50); // exactly one mountItem batch
    expect(scroller.getInfo().noNewer).toBe(false);                    // did not reach the global newest
    expect(viewport.scrollTop + 600).toBeLessThan(content.scrollHeight); // viewport not pinned to the absolute bottom
  });

  it('scrollToBottom (go-to-bottom) chains through a trimmed newer end to the global newest (followToNewest)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // m-400..m-499 pinned to bottom, noNewer=true
    // scroll up: trim the newest end → noNewer=false
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    // explicit scrollToBottom → followToNewest chains back to the global newest
    scroller.scrollToBottom();
    await flush();
    expect(scroller.getInfo().noNewer).toBe(true);
    expect(scroller.getInfo().newestId).toBe('m-499');
    expect(viewport.scrollTop + 600).toBeGreaterThanOrEqual(content.scrollHeight - 1); // pinned to the absolute bottom
  });

  // appendLive must NOT mount when the newer end is trimmed (!noNewer): mounting at the window tail would create a
  // cursor-order gap (live item before the unmounted m-251.. history) and let scrollToBottom→followToNewest chain to the
  // bottom. Cache only; items load in order when scrolling back down.
  it('appendLive with a trimmed newer end (noNewer=false) caches only, no mount, no jump to bottom', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // m-400..m-499 pinned to bottom, noNewer=true
    // scroll up: trim the newest end → noNewer=false (window is back in mid-history)
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    const mountedBefore = scroller.getInfo().mounted;
    const scrollTopBefore = viewport.scrollTop;
    // WS new message arrives (window in mid-history): cache only, no mount, no scrollToBottom
    scroller.appendLive([{ id: 'live-0', data: 999 }]);
    await flush();
    expect(scroller.getInfo().mounted).toBe(mountedBefore); // not mounted (prevents an order gap with m-251..)
    expect(viewport.scrollTop).toBe(scrollTopBefore);       // no jump to bottom
  });

  it('openAround: a source batch missing the target → safe no-op (no mount, no crash)', async () => {
    const { hooks } = controllableHooks();
    const src: CbSource<number> = {
      init: async () => [{ id: 'other-1', data: 1 }, { id: 'other-2', data: 2 }], // missing the target
      getOlder: async () => [], getNewer: async () => [],
      pushLive: () => {}, getPending: () => [], destroy: () => {},
    };
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    scroller.scrollToIndex('m-target', 'center');
    await flush();
    expect(scroller.getInfo().mounted).toBe(0); // !hasTarget early return, nothing mounted
  });

  it('two jumps in a row → gen guard: the in-flight first jump is dropped, the final window surrounds the second', async () => {
    const { hooks } = controllableHooks();
    const src = controllableInitSource(5000);
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    scroller.scrollToIndex('m-100', 'center'); // openAround #1: init pending (gen=1)
    scroller.scrollToIndex('m-200', 'center'); // openAround #2: ++gen=2, reset, init pending
    expect(src.initPending()).toBe(2);
    src.resolveInit(src.batchAround(100)); // #1 resolve → gen(1)≠2 → dropped
    src.resolveInit(src.batchAround(200)); // #2 resolve → mounts m-151..m-250
    await flush();
    const info = scroller.getInfo();
    expect(info.oldestId).toBe('m-151'); // surrounds m-200, not m-100
    expect(info.newestId).toBe('m-250');
  });

  // ── insertAfter: mid-window insert with NO balance + scrollTop compensation (Plan B) ──

  it('insertAfter on a non-mounted id → no-op (returns false, no mount, no load)', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    const mountedBefore = scroller.getInfo().mounted;
    const ok = scroller.insertAfter('m-9999', { id: 'ins', data: -1 });
    expect(ok).toBe(false);
    expect(scroller.getInfo().mounted).toBe(mountedBefore);
    expect(content.querySelector('[data-cb-id="ins"]')).toBeNull();
    expect(src.gets()).toBe(0);     // no balance → no loadOlder
    expect(src.newers()).toBe(0);   // no loadNewer
  });

  it('insertAfter mid-window → mounts at idx+1 in the right DOM position (between target and successor)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // m-400..m-499
    const mountedBefore = scroller.getInfo().mounted;
    const ok = scroller.insertAfter('m-450', { id: 'ins', data: -1 });
    expect(ok).toBe(true);
    expect(scroller.getInfo().mounted).toBe(mountedBefore + 1);
    const ids = Array.from(content.children).map(c => (c as HTMLElement).dataset['cbId']);
    const i = ids.indexOf('m-450');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(ids[i + 1]).toBe('ins');    // inserted right after the target
    expect(ids[i + 2]).toBe('m-451');  // successor still after the new item
  });

  it('insertAfter rebuilds the successor with the new prev; the new item is created once with the target as prev', async () => {
    const { hooks, calls } = recordingHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // mounts m-400..m-499 once each
    scroller.insertAfter('m-450', { id: 'ins', data: -1 });
    const ins = calls.filter(c => c.id === 'ins');
    expect(ins.length).toBe(1);
    expect(ins[0].prev).toBe('m-450');   // new item's prev = target
    const succ = calls.filter(c => c.id === 'm-451');
    expect(succ.length).toBe(2);         // init mount + rebuild
    expect(succ[1].prev).toBe('ins');    // rebuilt with prev = the new item
  });

  it('Plan B: insert above the viewport → scrollTop += new height (viewport pinned), no balance triggered', async () => {
    const { hooks } = controllableHooks(); // 100px/item
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init(); // pinned to bottom (scrollTop 9400); m-400 (top 0) is above the viewport
    const stBefore = viewport.scrollTop;
    const ok = scroller.insertAfter('m-400', { id: 'ins', data: -1 }); // ins at idx 1, top 100 < 9400 → compensate
    expect(ok).toBe(true);
    expect(viewport.scrollTop).toBe(stBefore + 100); // += newH (successor m-401 rebuild delta is 0)
    expect(src.gets()).toBe(0);                       // no balance → no loadOlder/loadNewer
    expect(src.newers()).toBe(0);
  });

  it('Plan B: insert below the viewport → scrollTop unchanged (content above the fold is untouched)', async () => {
    const { hooks } = controllableHooks(); // 100px/item
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // m-400..m-499
    scroller.scrollToIndex('m-450', 'top'); // scrollTop = topOf(m-450) = 5000; viewport [5000,5600]
    expect(viewport.scrollTop).toBe(5000);
    scroller.insertAfter('m-480', { id: 'ins', data: -1 }); // ins top 8100, below the viewport
    expect(viewport.scrollTop).toBe(5000); // no compensation (insert is below the fold)
  });

  // Regression: a transient inserted at the tail must NOT become the getNewer cursor. Without the cursor guard,
  // loadNewer would call getNewer('ins') → the source can't find it → [] → noNewer falsely locked → newer history
  // never loads. newerCursorId skips transient entries, so the real tail id is used instead.
  it('cursor guard: a transient at the tail does not poison loadNewer (no false noNewer lock)', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init(); // m-400..m-499, noNewer=true
    // scroll up: loadOlder prepends older + trimNewer trims the newest end → noNewer=false (mid-history)
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    const tailId = scroller.getInfo().newestId as string; // last real mounted item before insert
    // insert AFTER the last mounted item → the transient becomes the new tail
    const ok = scroller.insertAfter(tailId, { id: 'ins', data: -1 });
    expect(ok).toBe(true);
    expect(scroller.getInfo().newestId).toBe('ins'); // transient is now the tail
    // drain the cb-enter so the checkpoint is not deferred when scrolling to the bottom edge
    content.querySelector<HTMLElement>('[data-cb-id="ins"]')?.dispatchEvent(new Event('animationend'));
    // scroll down to the bottom edge → balance triggers loadNewer; cursor must skip the transient
    viewport.scrollTop = content.scrollHeight - 600;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.newers()).toBeGreaterThan(0);                      // getNewer was called with the real cursor (skipped 'ins')
    expect(scroller.getInfo().newestId).toBe('ins');              // transient stays at the tail (reals insert before the tail block)
    expect(scroller.getInfo().noNewer).toBe(false);               // NOT falsely locked (would be true without the guard)
    // reals were loaded before the transient: the item just newer than the original tail is now mounted
    expect(content.querySelector(`[data-cb-id="m-${num(tailId) + 1}"]`)).not.toBeNull();
  });

  // ── Phase A/B/C: enter animation, transient-safe trim, settle (optimistic→confirmed), removeItem (exit animation) ──

  /** Dispatch animationend on a host (drain cb-enter/cb-leave synchronously in tests; the real browser fires it at the
   *  CSS duration, but tests don't wait). */
  function animEnd(id: string): void {
    const el = content.querySelector<HTMLElement>(`[data-cb-id="${id}"]`);
    el?.dispatchEvent(new Event('animationend'));
  }

  it('Phase A: init/loadOlder mounts do NOT get cb-enter (only inserts + live arrivals animate)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(content.querySelectorAll('.cb-enter').length).toBe(0);
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(content.querySelectorAll('.cb-enter').length).toBe(0); // scroll-loaded history does not animate either
  });

  it('Phase A: insertAfter plays cb-enter on the new row; animationend removes it', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    scroller.insertAfter('m-450', { id: 'ins', data: -1 });
    const el = content.querySelector<HTMLElement>('[data-cb-id="ins"]');
    expect(el?.classList.contains('cb-enter')).toBe(true);
    animEnd('ins');
    expect(el?.classList.contains('cb-enter')).toBe(false);
  });

  it('Phase A: appendLive plays cb-enter on the live row', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    scroller.appendLive([{ id: 'x', data: -1 }]);
    await flush();
    expect(content.querySelector<HTMLElement>('[data-cb-id="x"]')?.classList.contains('cb-enter')).toBe(true);
  });

  it('Phase A: while cb-enter is in flight, balance is deferred; it resumes on animationend', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    const getsBefore = src.gets();
    scroller.insertAfter('m-400', { id: 'ins', data: -1 }); // cb-enter, animating=1
    viewport.scrollTop = 0;                                  // top edge → loadOlder would fire if balance ran
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.gets()).toBe(getsBefore);                    // deferred (animating>0)
    animEnd('ins');                                          // drain → balance resumes → loadOlder
    await flush();
    expect(src.gets()).toBeGreaterThan(getsBefore);
  });

  // The user's called-out bug: many transient fakes at the tail must not be eaten by trimNewer when loadOlder fires at
  // the top (transients are not in the source → trimming would permanently lose them).
  it('Phase A: trimNewer skips a transient at the tail (in-flight optimistic survives loadOlder)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // m-400..m-499
    scroller.insertAfter('m-499', { id: 'ins', data: -1 }); // transient at the tail
    animEnd('ins');                                         // drain cb-enter so balance can run
    await flush();
    viewport.scrollTop = 0;                                 // scroll to top → loadOlder + trimNewer
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().newestId).toBe('ins');        // transient survived the trim
    expect(content.querySelector('[data-cb-id="ins"]')).not.toBeNull();
  });

  // appendLive (direct-mount path) dedups by id: an incoming item matching a mounted transient/optimistic is skipped
  // (no duplicate mount). The optimistic→confirmed reconcile now goes through onMessageSignal + reconcileOptimistic
  // (covered in the signal/reconcile tests below), not appendLive.
  it('Phase B: appendLive dedups an item matching a mounted optimistic (no duplicate mount)', async () => {
    const { hooks } = controllableHooks();
    const base = fakeSource(500);
    const src: CbSource<number> = { ...base, pushLive: () => {} };
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    const mountedBefore = scroller.getInfo().mounted;
    scroller.insertAfter('m-499', { id: 'pending-0', data: -1 }, { optimistic: true }); // optimistic at tail
    expect(scroller.getInfo().mounted).toBe(mountedBefore + 1);
    animEnd('pending-0');                                         // drain its enter animation
    scroller.appendLive([{ id: 'pending-0', data: 777 }]);        // same id → dedup skips (no mount, no settle)
    await flush();
    expect(scroller.getInfo().mounted).toBe(mountedBefore + 1);   // no duplicate
    expect(content.querySelector('[data-cb-id="pending-0"]')).not.toBeNull();
  });

  // Optimistic→confirmed via the signal path: onMessageSignal pulls the real confirm via getNewer, mounts it visibly at
  // its true position, then reconcileOptimistic synchronously removes the optimistic duplicate and tags the real
  // cb-confirmed. Height model and mount count stay exact (one entry for the id throughout).
  it('onMessageSignal reconciles an optimistic send into its confirmed real (no duplicate, real revealed)', async () => {
    const { hooks } = controllableHooks();
    // getNewer returns the real confirm: a FRESH server id + the SAME clientMessageId as the optimistic (the reconcile
    // key — the kernel pairs them by clientMessageId, not id, since the real's id is brand-new). boundary newest so
    // noNewer is re-absorbed true.
    const base = fakeSource(500);
    const src: CbSource<number> = { ...base, getNewer: async () => [{ id: 'real-0', data: 777, clientMessageId: 'cid-0', boundary: 'newest' as const }], pushLive: () => {} };
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init(); // m-400..m-499 mounted, noNewer=true
    const mountedBefore = scroller.getInfo().mounted;
    scroller.insertAfter('m-499', { id: 'pending-0', data: -1, clientMessageId: 'cid-0' }, { optimistic: true }); // optimistic bubble at the tail (tracked by cid-0)
    animEnd('pending-0');                                                                                          // drain its cb-enter
    expect(scroller.getInfo().mounted).toBe(mountedBefore + 1);
    const p = scroller.onMessageSignal();                                                                          // confirm arrives → loadNewer + reconcile
    await flush();                                                                                                 // let loadNewer mount the real; reconcile is synchronous (no slide to drain)
    await p;
    await flush();
    // optimistic (pending-0) removed, real (real-0) revealed → the confirmed real remains at the tail — not trimmed.
    expect(content.querySelectorAll('[data-cb-id="pending-0"]').length).toBe(0);
    expect(content.querySelectorAll('[data-cb-id="real-0"]').length).toBe(1);
    expect(content.querySelector('[data-cb-id="real-0"]')?.classList.contains('cb-confirmed')).toBe(true); // real tagged cb-confirmed
  });

  // Regression (first-send scrollTop bug): after onMessageSignal reconciles the optimistic into its real, the confirmed
  // real MUST be pinned to the bottom (scrollTop = scrollHeight − vh). The bug: pinToBottom-after-reconcile left the real
  // below the fold on the FIRST send, subsequent sends correct. This pins both the first and a subsequent send.
  it('onMessageSignal pins the confirmed real to the bottom (first send AND subsequent)', async () => {
    const { hooks } = controllableHooks();
    const queue: { realId: string; cid: string }[] = [
      { realId: 'real-0', cid: 'cid-0' },
      { realId: 'real-1', cid: 'cid-1' },
    ];
    const base = fakeSource(500);
    const src: CbSource<number> = {
      ...base,
      getNewer: async () => { const n = queue.shift(); return n ? [{ id: n.realId, data: 777, clientMessageId: n.cid, boundary: 'newest' as const }] : []; },
      pushLive: () => {},
    };
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init(); // m-400..m-499, noNewer=true

    // --- Send #1 ---
    scroller.insertAfter('m-499', { id: 'pending-0', data: -1, clientMessageId: 'cid-0' }, { optimistic: true });
    animEnd('pending-0');
    scroller.scrollToBottom();
    await scroller.onMessageSignal();
    await flush();
    const i1 = scroller.getInfo();
    expect(content.querySelectorAll('[data-cb-id="real-0"]').length).toBe(1);
    expect(i1.atBottom).toBe(true);
    expect(i1.scrollTop).toBe(i1.scrollHeight - i1.viewportHeight); // real pinned to the bottom, not below the fold

    // --- Send #2 (the previously-correct case — must stay correct) ---
    scroller.insertAfter('real-0', { id: 'pending-1', data: -1, clientMessageId: 'cid-1' }, { optimistic: true });
    animEnd('pending-1');
    scroller.scrollToBottom();
    await scroller.onMessageSignal();
    await flush();
    const i2 = scroller.getInfo();
    expect(content.querySelectorAll('[data-cb-id="real-1"]').length).toBe(1);
    expect(i2.atBottom).toBe(true);
    expect(i2.scrollTop).toBe(i2.scrollHeight - i2.viewportHeight);
  });

  // Symmetric optimistic lifecycle: a push that extends the newest (a non-newest page lands while pinned at the newest)
  // UNMOUNTS the in-flight optimistic tail (they're recoverable via getPending); reaching the newest again RE-MOUNTS them.
  it('onMessageSignal unmounts optimistic on a non-newest push, re-mounts on reaching newest (getPending)', async () => {
    const { hooks } = controllableHooks();
    // Backlog source: getNewer drains a queue (page 1 = 50 reals WITHOUT 'newest', page 2 = reals WITH 'newest');
    // getPending returns the in-flight optimistic sends the kernel (re)mounts at the newest edge.
    const pending: CbItem<number>[] = [];
    const batches: CbItem<number>[][] = [
      Array.from({ length: 50 }, (_, i) => ({ id: `real-${i}`, data: i })),
      Array.from({ length: 10 }, (_, i) => ({ id: `r-${50 + i}`, data: 50 + i, boundary: 'newest' as const })),
    ];
    const base = fakeSource(500);
    const src: CbSource<number> = { ...base, getNewer: async () => batches.shift() ?? [], pushLive: () => {}, getPending: () => pending.slice() };
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init(); // m-400..m-499, noNewer=true
    const optA: CbItem<number> = { id: 'opt-a', clientMessageId: 'cid-a', data: -1 };
    const optB: CbItem<number> = { id: 'opt-b', clientMessageId: 'cid-b', data: -1 };
    pending.push(optA, optB);                                  // playground addPending (the backing store)
    scroller.insertAfter('m-499', optA, { optimistic: true }); // mount for immediate display
    scroller.insertAfter('opt-a', optB, { optimistic: true });
    animEnd('opt-a'); animEnd('opt-b');
    expect(content.querySelectorAll('[data-cb-id="opt-a"]').length).toBe(1);
    expect(content.querySelectorAll('[data-cb-id="opt-b"]').length).toBe(1);

    // Push #1: a 50-real page WITHOUT 'newest' (large backlog). wasAtNewest=true → noNewer=false → optimistic unmounted.
    await scroller.onMessageSignal();
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    expect(content.querySelectorAll('[data-cb-id="opt-a"]').length).toBe(0);  // unmounted (recoverable via getPending)
    expect(content.querySelectorAll('[data-cb-id="opt-b"]').length).toBe(0);
    expect(content.querySelectorAll('[data-cb-id="real-49"]').length).toBe(1); // the 50 backlog reals did mount

    // Scroll back to the newest → followToNewest loads page 2 (newest) → elevatePending re-mounts the in-flight sends.
    scroller.scrollToBottom();
    await flush();
    expect(scroller.getInfo().noNewer).toBe(true);
    expect(content.querySelectorAll('[data-cb-id="opt-a"]').length).toBe(1);  // re-mounted via getPending
    expect(content.querySelectorAll('[data-cb-id="opt-b"]').length).toBe(1);
    expect(scroller.getInfo().newestId).toBe('opt-b');                        // optimistic block is the tail again
  });

  // Regression: a SMALL push (the page reaches the global newest) does NOT unmount optimistic — noNewer stays true,
  // elevatePending skips already-mounted sends. Only a non-newest push (the backlog case above) unmounts them.
  it('onMessageSignal with a newest-reaching page keeps optimistic mounted (small push → no unmount)', async () => {
    const { hooks } = controllableHooks();
    const pending: CbItem<number>[] = [];
    const base = fakeSource(500);
    const src: CbSource<number> = { ...base, getNewer: async () => [{ id: 'real-0', data: 0, boundary: 'newest' as const }], pushLive: () => {}, getPending: () => pending.slice() };
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init(); // noNewer=true
    const optA: CbItem<number> = { id: 'opt-a', clientMessageId: 'cid-a', data: -1 };
    pending.push(optA);
    scroller.insertAfter('m-499', optA, { optimistic: true });
    animEnd('opt-a');
    await scroller.onMessageSignal();
    await flush();
    expect(scroller.getInfo().noNewer).toBe(true);
    expect(content.querySelectorAll('[data-cb-id="opt-a"]').length).toBe(1); // survived (elevate skipped it — already mounted)
    expect(content.querySelectorAll('[data-cb-id="real-0"]').length).toBe(1);
  });

  it('onMessageSignal with a trimmed newer end (noNewer=false) caches only — no load, no mount', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    viewport.scrollTop = 0; viewport.dispatchEvent(new Event('scroll')); await flush(); // scroll up → noNewer=false
    expect(scroller.getInfo().noNewer).toBe(false);
    const mountedBefore = scroller.getInfo().mounted;
    const newersBefore = src.newers();
    await scroller.onMessageSignal();
    expect(scroller.getInfo().mounted).toBe(mountedBefore);       // nothing mounted (cached only; loaded on scroll-back)
    expect(src.newers()).toBe(newersBefore);                      // getNewer not called (gate: !noNewer → return)
  });

  it('Phase C: removeItem(mountedId) plays cb-leave then unmounts on animationend; returns 1', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const mountedBefore = scroller.getInfo().mounted;
    const n = scroller.removeItem('m-450');
    expect(n).toBe(1);
    const el = content.querySelector<HTMLElement>('[data-cb-id="m-450"]');
    expect(el?.classList.contains('cb-leave')).toBe(true);
    expect(scroller.getInfo().mounted).toBe(mountedBefore); // still mounted during the animation
    animEnd('m-450');
    await flush();
    expect(scroller.getInfo().mounted).toBe(mountedBefore - 1);
    expect(content.querySelector('[data-cb-id="m-450"]')).toBeNull();
  });

  it('Phase C: removeItem(not-mounted) returns 0 with no mutation', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const mountedBefore = scroller.getInfo().mounted;
    expect(scroller.removeItem('m-9999')).toBe(0);
    expect(scroller.removeItem(['m-9999', 'm-8888'])).toBe(0);
    expect(scroller.getInfo().mounted).toBe(mountedBefore);
  });

  it('Phase C: removeItem(array) removes multiple concurrently; an album-member id resolves to the album item', async () => {
    const { hooks } = controllableHooks();
    const mergeItems = (items: CbItem<number>[]): CbItem<number>[] => { // collapse m-450,451,452 into one album
      const out: CbItem<number>[] = [];
      let i = 0;
      while (i < items.length) {
        const a = items[i], b = items[i + 1], c = items[i + 2];
        if (String(a.id) === 'm-450' && b && String(b.id) === 'm-451' && c && String(c.id) === 'm-452') {
          out.push({ ...a, ids: ['m-450', 'm-451', 'm-452'] }); i += 3;
        } else { out.push(a); i++; }
      }
      return out;
    };
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks: { ...hooks, mergeItems }, source: fakeSource(500) });
    await scroller.init();
    const mountedBefore = scroller.getInfo().mounted;
    // m-451 is a non-head album member → resolves to the album item (m-450..452); m-460 is a separate item.
    const n = scroller.removeItem(['m-451', 'm-460']);
    expect(n).toBe(2); // dedup: the album counts once
    for (const id of ['m-450', 'm-460']) animEnd(id);
    await flush();
    expect(scroller.getInfo().mounted).toBe(mountedBefore - 2);
    expect(content.querySelector('[data-cb-id="m-450"]')).toBeNull(); // whole album gone
  });

  it('Phase C: while a cb-leave is in flight, balance is deferred; it resumes on animationend', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    const getsBefore = src.gets();
    scroller.removeItem('m-400');                    // cb-leave, animating=1
    viewport.scrollTop = 0;                          // top edge → loadOlder would fire if balance ran
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.gets()).toBe(getsBefore);            // deferred
    animEnd('m-400');                               // drain → balance resumes → loadOlder
    await flush();
    expect(src.gets()).toBeGreaterThan(getsBefore);
  });

  it('Phase C: removeItem above the viewport compensates scrollTop (-= height) on animationend', async () => {
    const { hooks } = controllableHooks(); // 100px/item
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // pinned to bottom; m-400 (top 0) is above the viewport
    const stBefore = viewport.scrollTop;
    scroller.removeItem('m-400'); // above the fold
    animEnd('m-400');
    await flush();
    expect(viewport.scrollTop).toBe(stBefore - 100); // pinned: content below shifted up by the removed height
  });

  // ── Tail cap: persistent non-message element at the newer edge (mirrors the top ghost; never in mounted[]) ──

  it('tail cap: always the last child of content, exactly one, after init', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const caps = content.querySelectorAll('.cb-tail-cap');
    expect(caps.length).toBe(1);
    expect(content.lastElementChild).toBe(caps[0]); // always last: every append inserts before it
  });

  it('tail cap: gap mode at the global newest (noNewer) — cb-tail-cap--gap, height measured + folded into totalH', async () => {
    const { hooks } = controllableHooks(); // 100px/item
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // pinned to bottom → noNewer=true
    expect(scroller.getInfo().noNewer).toBe(true);
    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    expect(cap.classList.contains('cb-tail-cap--gap')).toBe(true);
    expect(cap.classList.contains('cb-tail-cap--loading')).toBe(false);
    expect(cap.offsetHeight).toBe(14); // MEASURED: CSS owns the dimension, the kernel reads offsetHeight
    expect(sumChildrenHeight(content)).toBe(100 * 100 + 14); // cap height folded into the content total
  });

  it('tail cap: loading mode (!noNewer) after a mid-history jump — cb-tail-cap--loading spinner', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 'm-2500', anchor: 'center' }); // mid-history → noNewer=false
    expect(scroller.getInfo().noNewer).toBe(false);
    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    expect(cap.classList.contains('cb-tail-cap--loading')).toBe(true);
    expect(cap.classList.contains('cb-tail-cap--gap')).toBe(false);
    expect(cap.offsetHeight).toBe(48); // same row height as the top ghost spinner
  });

  it('tail cap: loading→gap when scrollToBottom reaches the global newest (re-measured on the reaching batch)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // noNewer=true → gap
    scroller.scrollToIndex('m-100', 'center'); // re-seed mid-history → noNewer=false → loading
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    expect(content.querySelector('.cb-tail-cap')!.classList.contains('cb-tail-cap--loading')).toBe(true);
    scroller.scrollToBottom(); // followToNewest chains to the global newest
    await flush();
    expect(scroller.getInfo().noNewer).toBe(true);
    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    expect(cap.classList.contains('cb-tail-cap--gap')).toBe(true);
    expect(cap.offsetHeight).toBe(14); // height re-measured 48→14 on the batch that reached newest
  });

  it('tail cap: never in mounted[] — newestId is the last real item, the cap carries no data-cb-id', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    expect(cap.dataset['cbId']).toBeUndefined();        // not a rendered item → no cursor corruption
    expect(scroller.getInfo().newestId).toBe('m-499');  // cursor is the last REAL item, never the cap
  });

  it('tail cap: persists across a re-seed (unmountAll keeps it; still exactly one after a jump)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init();
    expect(content.querySelectorAll('.cb-tail-cap').length).toBe(1);
    scroller.scrollToIndex('m-100', 'center'); // re-seed: unmountAll does NOT remove the cap
    await flush();
    expect(content.querySelectorAll('.cb-tail-cap').length).toBe(1); // reused, not duplicated
    expect(content.lastElementChild?.classList.contains('cb-tail-cap')).toBe(true);
  });

  it('tail cap: optimistic insert at the tail while noNewer stays gap (no phantom spinner under a sent message)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // noNewer=true
    scroller.insertAfter('m-499', { id: 'ins', data: -1 }); // transient inserted before the cap
    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    expect(cap.classList.contains('cb-tail-cap--gap')).toBe(true); // still gap, NOT loading
    expect(content.lastElementChild).toBe(cap);                    // cap still last
    expect(content.querySelector('[data-cb-id="ins"]')?.nextElementSibling).toBe(cap); // transient before the cap
  });

  it('tail cap: destroy removes it (content fully empty)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(content.querySelector('.cb-tail-cap')).not.toBeNull();
    scroller.destroy();
    expect(content.querySelectorAll('.cb-tail-cap').length).toBe(0);
    expect(content.children.length).toBe(0);
  });

  // ── Viewport resize reflow: pin-on-shrink (soft keyboard), no balance/load jank ──

  it('resize: shrink while pinned to bottom → re-pins to the new bottom (before the fix the bottom dropped below the fold)', async () => {
    const { hooks } = controllableHooks(); // 100px/item
    const vh = mutableVh(viewport, 600);
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // pinned to bottom with vh=600
    expect(scroller.getInfo().atBottom).toBe(true);
    const total = content.scrollHeight;       // unchanged by a vh-only resize
    vh.set(300);                              // keyboard shrinks the layout viewport
    reflow(scroller);
    // re-pinned to the new bottom. Before the fix the old viewportObs ran balance (a no-op at bottom) but never
    // re-pinned → scrollTop stayed at scrollHeight-600 while vh became 300 → atBottom false (bottom 300px cut off).
    expect(viewport.scrollTop).toBe(total - 300);
    expect(scroller.getInfo().atBottom).toBe(true);
  });

  it('resize: shrink mid-history → scrollTop anchor preserved (same line stays in view), no load/trim', async () => {
    const { hooks } = controllableHooks();
    const vh = mutableVh(viewport, 600);
    const src = fakeSource(5000);
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init({ startMsgId: 'm-2500', anchor: 'center' }); // mid-history, NOT at bottom
    const stBefore = viewport.scrollTop;
    const getsBefore = src.gets();
    const newersBefore = src.newers();
    vh.set(300);                              // keyboard shrinks the viewport
    reflow(scroller);
    await flush();
    expect(viewport.scrollTop).toBe(stBefore); // absolute scrollTop unchanged → reading position preserved
    expect(src.gets()).toBe(getsBefore);       // no loadOlder
    expect(src.newers()).toBe(newersBefore);   // no loadNewer
  });

  // The pin the reflow issues writes scrollTop → fires an async scroll event after `shifting` has reset. Without the
  // suppress guard that scroll event re-arms balance and (when noNewer=false) loadNewer at the bottom — the visible
  // jitter during a keyboard shrink. Setup: scroll up so trimNewer opens the newer end (noNewer=false), sit at the
  // window bottom (atBottom true), then shrink + reflow and dispatch the pin's scroll event.
  it('resize: shrink at the bottom (noNewer=false) → suppress guard swallows the pin scroll event, no loadNewer', async () => {
    const { hooks } = controllableHooks();
    const vh = mutableVh(viewport, 600);
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init(); // m-400..m-499 pinned, noNewer=true
    viewport.scrollTop = 0;                    // scroll up → loadOlder + trimNewer opens the newer end
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    // sit at the window bottom (atBottom true, noNewer false) WITHOUT dispatching a scroll event (no balance yet):
    viewport.scrollTop = content.scrollHeight - 600;
    expect(scroller.getInfo().atBottom).toBe(true);
    const newersBefore = src.newers();
    vh.set(300);                               // keyboard shrinks the viewport → reflow pins + arms the suppress guard
    reflow(scroller);
    viewport.dispatchEvent(new Event('scroll')); // the pin's async scroll event
    await flush();
    expect(src.newers()).toBe(newersBefore);   // guard swallowed it → no balance, no loadNewer (was the jitter source)
  });

  // ── reconcilePending: in-place failure morph + FLIP reorder (sending→failed, sink to tail, stable clientMessageId) ──

  it('reconcilePending morphs a failed send IN PLACE (same node, update not recreate, no cb-leave/cb-enter)', async () => {
    const t = trackingHooks();
    const pending: CbItem<number>[] = [];
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks: t.hooks, source: pendingSource(500, pending) });
    await scroller.init();
    const opt: CbItem<number> = { id: 'cid-0', data: 1, clientMessageId: 'cid-0' };
    pending.push(opt);
    scroller.insertAfter('m-499', opt, { optimistic: true }); // optimistic bubble at the tail
    animEnd('cid-0');                                         // drain its cb-enter
    const elBefore = content.querySelector('[data-cb-id="cid-0"]');
    const mountedBefore = scroller.getInfo().mounted;
    const createsBefore = t.createCount();
    const updatesBefore = t.updateCount();

    // The source flips status (a NEW data ref, same id/clientMessageId) — mirrors MockItemSource.failPending.
    pending[0] = { id: 'cid-0', data: 2, clientMessageId: 'cid-0' };
    await scroller.reconcilePending();

    expect(content.querySelector('[data-cb-id="cid-0"]')).toBe(elBefore); // SAME DOM node (no destroy+recreate)
    expect(t.createCount()).toBe(createsBefore);                          // createItem NOT re-called
    expect(t.updateCount()).toBe(updatesBefore + 1);                      // update applied
    expect(t.dataOf('cid-0')).toBe(2);                                    // new data rendered
    expect(scroller.getInfo().mounted).toBe(mountedBefore);               // mount count unchanged
    expect(content.querySelector('[data-cb-id="cid-0"]')?.classList.contains('cb-move')).toBe(false); // single send already at the tail → no move
  });

  it('reconcilePending FLIP-reorders a failed send to the tail; the shoved sibling animates too (no hard cut)', async () => {
    const { hooks } = controllableHooks();
    const pending: CbItem<number>[] = [];
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: pendingSource(500, pending) });
    await scroller.init();
    const A: CbItem<number> = { id: 'cid-A', data: 10, clientMessageId: 'cid-A' };
    const B: CbItem<number> = { id: 'cid-B', data: 20, clientMessageId: 'cid-B' };
    pending.push(A, B);
    scroller.insertAfter('m-499', A, { optimistic: true });
    animEnd('cid-A');
    scroller.insertAfter('cid-A', B, { optimistic: true });
    animEnd('cid-B');
    // Tail was [..., m-499, cid-A, cid-B]. Source fails A and sinks it to the end → pending order [cid-B, cid-A].
    pending.splice(0, 2, { id: 'cid-B', data: 20, clientMessageId: 'cid-B' }, { id: 'cid-A', data: 11, clientMessageId: 'cid-A' });
    await scroller.reconcilePending();

    const ids = Array.from(content.children).filter(c => (c as HTMLElement).dataset['cbId']).map(c => (c as HTMLElement).dataset['cbId'] as string);
    const i = ids.lastIndexOf('m-499');
    expect(ids.slice(i + 1)).toEqual(['cid-B', 'cid-A']);                  // A sunk to the tail; reals above untouched
    // BOTH animate: A slid down to the tail AND B shoved up by A's height (the sibling-must-animate regression).
    expect(content.querySelector('[data-cb-id="cid-A"]')?.classList.contains('cb-move')).toBe(true);
    expect(content.querySelector('[data-cb-id="cid-B"]')?.classList.contains('cb-move')).toBe(true);
    animEnd('cid-A'); animEnd('cid-B');
    expect(content.querySelector('[data-cb-id="cid-A"]')?.classList.contains('cb-move')).toBe(false);
    expect(content.querySelector('[data-cb-id="cid-B"]')?.classList.contains('cb-move')).toBe(false);
  });

  it('reconcilePending morphs a retried send back in place at its position (no remount, no move)', async () => {
    const t = trackingHooks();
    const pending: CbItem<number>[] = [];
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks: t.hooks, source: pendingSource(500, pending) });
    await scroller.init();
    pending.push({ id: 'cid-A', data: 10, clientMessageId: 'cid-A' });
    scroller.insertAfter('m-499', pending[0], { optimistic: true });
    animEnd('cid-A');
    pending[0] = { id: 'cid-A', data: 11, clientMessageId: 'cid-A' }; // fail it
    await scroller.reconcilePending();
    animEnd('cid-A');
    const elFailed = content.querySelector('[data-cb-id="cid-A"]');
    const createsBeforeRetry = t.createCount();

    pending[0] = { id: 'cid-A', data: 12, clientMessageId: 'cid-A' }; // retry: flip back, SAME id/position
    await scroller.reconcilePending();

    expect(content.querySelector('[data-cb-id="cid-A"]')).toBe(elFailed); // same node across fail+retry
    expect(t.createCount()).toBe(createsBeforeRetry);                    // no remount on retry
    expect(content.querySelector('[data-cb-id="cid-A"]')?.classList.contains('cb-move')).toBe(false); // single pending → no reorder
    expect(t.dataOf('cid-A')).toBe(12);
  });

  it('destroy during a FLIP move drains cleanly (moveTimer cleared, animating not leaked)', async () => {
    const { hooks } = controllableHooks();
    const pending: CbItem<number>[] = [];
    scroller = new ChatBoxScroller<number>({ viewport, content, hooks, source: pendingSource(500, pending) });
    await scroller.init();
    pending.push({ id: 'cid-A', data: 10, clientMessageId: 'cid-A' }, { id: 'cid-B', data: 20, clientMessageId: 'cid-B' });
    scroller.insertAfter('m-499', pending[0], { optimistic: true });
    animEnd('cid-A');
    scroller.insertAfter('cid-A', pending[1], { optimistic: true });
    animEnd('cid-B');
    pending.splice(0, 2, { id: 'cid-B', data: 20, clientMessageId: 'cid-B' }, { id: 'cid-A', data: 11, clientMessageId: 'cid-A' });
    await scroller.reconcilePending();
    expect(content.querySelector('[data-cb-id="cid-A"]')?.classList.contains('cb-move')).toBe(true); // move in flight
    expect(() => scroller?.destroy()).not.toThrow();                                                // teardown mid-move (cancelEntryAnim clears moveTimer)
    scroller = undefined;                                                                           // afterEach will skip the now-destroyed scroller
  });
});
