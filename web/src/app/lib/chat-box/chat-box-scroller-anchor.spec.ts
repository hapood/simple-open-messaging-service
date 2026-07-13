/**
 * ChatBoxScrollerAnchor (Plan A: browser-anchor-assisted) unit tests — array index-based.
 *
 * Focuses on the key difference between Plan A and B: on loadOlder (top prepend) / above-fold changes the
 * kernel does NOT write scrollTop (delegated to browser overflow-anchor). The mock environment has no
 * browser anchoring, so asserting "scrollTop is not mutated by the kernel" proves no compensation.
 *
 * The mock source uses a numeric msgId cursor (0..N-1, 0 = oldest), not a contiguous abstract id — verifying
 * the kernel index is decoupled from the source id.
 */
import { ChatBoxScrollerAnchor, CbElement, CbItem } from './chat-box-scroller-anchor';
import type { CbSource } from './cb-source';

/** Sum of content children offsetHeight (verifies totalH). */
function sumChildrenHeight(el: HTMLElement): number {
  let s = 0;
  for (const c of Array.from(el.children)) s += (c as HTMLElement).offsetHeight || 0;
  return s;
}

/** Controllable hooks: createItem(item) with a fixed per-item height. Does not depend on id value (item.id is a numeric msgId). */
function controllableHooks(itemHeight = 100): { hooks: { createItem: (item: CbItem<number>, prev: CbItem<number> | null) => CbElement<number> } } {
  return {
    hooks: {
      createItem: (item): CbElement<number> => {
        void item;
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => itemHeight });
        return { el, onHeightChange: () => () => {}, update: () => {}, destroy: () => {} };
      },
    },
  };
}

/** Hooks that record createItem vs update so reconcilePending tests can assert in-place morph (update, NOT recreate). */
function trackingHooks(itemHeight = 100): {
  hooks: { createItem: (item: CbItem<number>, prev: CbItem<number> | null) => CbElement<number> };
  createCount: () => number;
  updateCount: () => number;
  dataOf: (id: number) => number;
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
    dataOf: (id) => dataMap.get(String(id)) ?? -1,
  };
}

/** fakeSource with a mutable pending array the test mutates to simulate MockItemSource.failPending/retryPending. */
function pendingSource(total: number, pending: CbItem<number>[]): CbSource<number> {
  return { ...fakeSource(total), getPending: () => pending.slice() };
}

/** Fake source: N msgs (0 = oldest .. N-1 = newest). Cursors getOlder/getNewer, returned in ascending order. */
function fakeSource(N: number): CbSource<number> & { gets: () => number; newers: () => number } {
  const itemAt = (i: number): CbItem<number> | undefined => {
    if (i < 0 || i >= N) return undefined;
    const boundary = i === 0 ? 'oldest' as const : i === N - 1 ? 'newest' as const : undefined;
    return boundary ? { id: i, data: i, boundary } : { id: i, data: i };
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
      if (anchorId === -1) return slice(N - older, N);
      const idx = anchorId;
      if (idx < 0 || idx >= N) return [];
      const olderStart = Math.max(0, idx - older + 1);
      const newerEnd = Math.min(N, idx + 1 + newer);
      return [...slice(olderStart, idx + 1), ...slice(idx + 1, newerEnd)];
    },
    getOlder: async (cursorId, count) => { gets++; const k = cursorId; return slice(k - count, k); },
    getNewer: async (cursorId, count) => { newers++; const k = cursorId; return slice(k + 1, k + 1 + count); },
    pushLive: (_items) => { /* cache-only: direct-mount path mounts the raw items */ },
    getPending: () => [],
    destroy: () => {},
  };
  return Object.assign(src, { gets: () => gets, newers: () => newers });
}

/** Source with controllable init: init returns a manually-resolved Promise (to test consecutive-jump gen supersession). */
function controllableInitSource(N: number): CbSource<number> & {
  resolveInit: (items: CbItem<number>[]) => void; initPending: () => number; batchAround: (k: number) => CbItem<number>[];
} {
  const itemAt = (i: number): CbItem<number> | undefined => {
    if (i < 0 || i >= N) return undefined;
    const boundary = i === 0 ? 'oldest' as const : i === N - 1 ? 'newest' as const : undefined;
    return boundary ? { id: i, data: i, boundary } : { id: i, data: i };
  };
  const slice = (lo: number, hi: number): CbItem<number>[] => {
    const out: CbItem<number>[] = [];
    for (let i = Math.max(0, lo); i < Math.min(N, hi); i++) { const it = itemAt(i); if (it) out.push(it); }
    return out;
  };
  const queue: ((items: CbItem<number>[]) => void)[] = [];
  const src: CbSource<number> = {
    init: () => new Promise<CbItem<number>[]>(resolve => { queue.push(resolve); }),
    getOlder: async (c, k) => { const i = c; return slice(i - k, i); },
    getNewer: async (c, k) => { const i = c; return slice(i + 1, i + 1 + k); },
    pushLive: (_items) => { /* cache-only: direct-mount path mounts the raw items */ },
    getPending: () => [],
    destroy: () => {},
  };
  return Object.assign(src, {
    resolveInit: (items: CbItem<number>[]) => { const r = queue.shift(); if (r) r(items); },
    initPending: () => queue.length,
    batchAround: (k: number) => [...slice(Math.max(0, k - 49), k + 1), ...slice(k + 1, k + 51)],
  });
}

/** Drain microtasks (openAround/fillAround are multi-hop async). */
async function flush(n = 30): Promise<void> { for (let i = 0; i < n; i++) await Promise.resolve(); }

/** Controllable source: getOlder returns a manually-resolved Promise, to test modifying scrollTop while "getOlder in flight" (reverse fling). */
function controllableSource(N: number): CbSource<number> & {
  gets: () => number; resolveOlder: (items?: CbItem<number>[]) => void; isPending: () => boolean;
} {
  const itemAt = (i: number): CbItem<number> | undefined => {
    if (i < 0 || i >= N) return undefined;
    const boundary = i === 0 ? 'oldest' as const : i === N - 1 ? 'newest' as const : undefined;
    return boundary ? { id: i, data: i, boundary } : { id: i, data: i };
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
    // Plain function returning a Promise (not async — avoids an extra thenable-assimilation microtask that would block the test flush)
    getOlder: function (cursorId: number, count: number): Promise<CbItem<number>[]> {
      gets++; const k = cursorId; pendingRange = { lo: k - count, hi: k };
      return new Promise(resolve => { resolver = (items?: CbItem<number>[]) => resolve(items ?? slice(pendingRange.lo, pendingRange.hi)); });
    },
    getNewer: async (cursorId, count) => { const k = cursorId; return slice(k + 1, k + 1 + count); },
    pushLive: (_items) => { /* cache-only: direct-mount path mounts the raw items */ },
    getPending: () => [],
    destroy: () => {},
  };
  return Object.assign(src, {
    gets: () => gets,
    resolveOlder: (items?: CbItem<number>[]) => { if (resolver) { const r = resolver; resolver = null; r(items); } },
    isPending: () => resolver !== null,
  });
}

describe('ChatBoxScrollerAnchor (Plan A · array index)', () => {
  let viewport: HTMLDivElement;
  let content: HTMLDivElement;
  let scroller: ChatBoxScrollerAnchor<number> | undefined;
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
    let ch = 0;
    Object.defineProperty(content, 'scrollHeight', { configurable: true, get: () => { let s = 0; for (const c of Array.from(content.children)) s += (c as HTMLElement).offsetHeight || 0; return s || ch; } });
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

  it('init takes the newest batch, pins to bottom, window boundary msgIds are correct', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const info = scroller.getInfo();
    expect(info.mounted).toBe(100);          // initBatch=100 (100×100px=10000 > threshold 6000, no refill)
    expect(info.oldestId).toBe(400);      // oldest in this batch
    expect(info.newestId).toBe(499);      // anchor = newest
    expect(info.atBottom).toBe(true);
  });

  it('Plan A: after loadOlder scrollTop is NOT compensated by the kernel (key difference from B)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    viewport.scrollTop = 50;
    const stBefore = viewport.scrollTop;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve(); // flush loadOlder
    await Promise.resolve();
    // Plan A does not compensate: scrollTop stays at the scrolled value (no += newly mounted height)
    expect(viewport.scrollTop).toBe(stBefore);
  });

  it('measurePending removes the cb-pending class from mounted elements', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(content.querySelectorAll('.cb-pending').length).toBe(0);
  });

  // ── Phase 0: noOlder absorb timing (absorb only after revalidate passes; Plan A fixed alike) ──

  it('Phase 0: reverse fling skips mounting the oldest-boundary batch → noOlder is not locked, getOlder still fires on return to top', async () => {
    const { hooks } = controllableHooks();
    const src = controllableSource(120); // init 100 → first getOlder returns m-0..m-19 (includes oldest=m-0)
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    expect(scroller.getInfo().noOlder).toBe(false);

    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    expect(src.isPending()).toBe(true);

    // reverse fling: leave the top edge + direction down
    viewport.scrollTop = 2000;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve();

    src.resolveOlder();
    await Promise.resolve();
    expect(scroller.getInfo().noOlder).toBe(false); // before the fix this got locked to true (bug)

    const getsBefore = src.gets();
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    expect(src.gets()).toBeGreaterThan(getsBefore);
  });

  // ── Phase 1: skeleton item (cb-ghost, Plan A alike; does not compensate scrollTop) ──

  it('Phase 1: after init the top mounted[0] shows cb-ghost (not yet at oldest), and exactly one', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const oldest = scroller.getInfo().oldestId!;
    expect(content.querySelector(`[data-cb-id="${oldest}"]`)?.classList.contains('cb-ghost')).toBe(true);
    expect(content.querySelectorAll('.cb-ghost').length).toBe(1);
  });

  it('Phase 1: scroll to the global oldest (noOlder) → cb-ghost disappears', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(120) });
    await scroller.init();
    for (let i = 0; i < 6; i++) {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    }
    expect(scroller.getInfo().noOlder).toBe(true);
    expect(content.querySelectorAll('.cb-ghost').length).toBe(0);
  });

  it('loadOlder truncates the newest edge → noNewer resets to false (loadNewer can load it back; fixes scroll-down/bottom-pin stuck)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(scroller.getInfo().noNewer).toBe(true);
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve(); await Promise.resolve();
    expect(scroller.getInfo().noNewer).toBe(false);
  });

  it('destroy clears all mounts', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    scroller.destroy();
    expect(content.children.length).toBe(0);
  });

  // ── Jump to a specific id (Plan A and B jump paths are isomorphic: openAround/fillAround/positionMounted identical) ──

  it('scrollToIndex already mounted → positioned by anchor (top/center/bottom)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    scroller.scrollToIndex(450, 'top');
    expect(viewport.scrollTop).toBe(5000);
    scroller.scrollToIndex(450, 'center');
    expect(viewport.scrollTop).toBe(4750);
    scroller.scrollToIndex(450, 'bottom');
    expect(viewport.scrollTop).toBe(4500);
  });

  it('init({startMsgId}) mid-range → two-sided window around the target, centered (no fill)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 2500, anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.oldestId).toBe(2451);
    expect(info.newestId).toBe(2550);
    expect(info.noOlder).toBe(false);
    expect(info.noNewer).toBe(false);
    expect(viewport.scrollTop).toBe(4650);
  });

  it('scrollToIndex not mounted → re-seed window around id; target mounted and centered', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init();
    scroller.scrollToIndex(100, 'center');
    await flush();
    const info = scroller.getInfo();
    expect(info.oldestId).toBe(51);
    expect(info.newestId).toBe(150);
    expect(viewport.scrollTop).toBe(4650);
  });

  // Regression (mirror of B-kernel): jumping to a NON-HEAD member of a merged album must resolve to its
  // album item via CbItem.ids. Pre-fix the viewport ended up empty (hasTarget false → early return).
  it('scrollToIndex to a non-head album member msgId → resolves to album item, window non-empty (ids member-resolution regression)', async () => {
    const { hooks } = controllableHooks();
    const mergeItems = (items: CbItem<number>[]): CbItem<number>[] => {
      const out: CbItem<number>[] = [];
      let i = 0;
      while (i < items.length) {
        const a = items[i], b = items[i + 1], c = items[i + 2];
        if (a.id === 10 && b && b.id === 11 && c && c.id === 12) {
          out.push({ ...a, ids: [10, 11, 12] });
          i += 3;
        } else { out.push(a); i++; }
      }
      return out;
    };
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks: { ...hooks, mergeItems }, source: fakeSource(5000) });
    await scroller.init();
    scroller.scrollToIndex(11, 'center'); // non-head album member
    await flush();
    const info = scroller.getInfo();
    expect(info.mounted).toBeGreaterThan(0);
    expect(info.oldestId!).toBeLessThanOrEqual(10);
    expect(info.newestId!).toBeGreaterThanOrEqual(12);
    expect(viewport.scrollTop).toBe(750);
  });

  it('jump near the oldest → noOlder; above-side under threshold/2 → below-side compensates up to threshold', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 5, anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noOlder).toBe(true);
    expect(info.newestId).toBe(105);
    expect(info.noNewer).toBe(false);
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000);
  });

  it('jump near the newest → noNewer; below-side under threshold/2 → above-side compensates up to threshold', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 4995, anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noNewer).toBe(true);
    expect(info.oldestId).toBe(4896);
    expect(info.noOlder).toBe(false);
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000);
  });

  it('jump in a tiny conversation → both sides hit the boundary, totalH<threshold, rendered directly', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(30) });
    await scroller.init({ startMsgId: 15, anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noOlder).toBe(true);
    expect(info.noNewer).toBe(true);
    expect(info.mounted).toBe(30);
  });

  it('jump with short items → fill loop extends both sides up to threshold/2', async () => {
    const { hooks } = controllableHooks(10);
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 2500, anchor: 'center' });
    expect(scroller.getInfo().mounted).toBeGreaterThan(100);
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000);
  });

  it('scrollToIndex highlight → adds cb-jump-highlight to the target row', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    scroller.scrollToIndex(450, 'top', true);
    const el = content.querySelector<HTMLElement>('[data-cb-id="450"]');
    expect(el?.classList.contains('cb-jump-highlight')).toBe(true);
  });

  // ── Coverage: scrollToTop / refresh / loadNewer (load downward) / openAround boundary / gen supersession ──

  it('scrollToTop → scrollTop=0', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(viewport.scrollTop).toBeGreaterThan(0);
    scroller.scrollToTop();
    expect(viewport.scrollTop).toBe(0);
  });

  it('refresh → re-measures vh + balance; does not throw, window stays usable', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(() => scroller!.refresh()).not.toThrow();
    scroller.scrollToIndex(scroller.getInfo().newestId!, 'top');
    expect(viewport.scrollTop).toBeGreaterThanOrEqual(0);
  });

  it('scroll down to the bottom edge → loadNewer triggers getNewer; newestId advances toward newest', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    await scroller.init(); // pinned to bottom, noNewer=true
    viewport.scrollTop = 0; // scroll up → loadOlder → trimNewer → noNewer=false
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    const newestBefore = scroller.getInfo().newestId!;
    viewport.scrollTop = content.scrollHeight - 600; // pin to bottom → loadNewer
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.newers()).toBeGreaterThan(0);
    expect(scroller.getInfo().newestId!).toBeGreaterThan(newestBefore);
  });

  it('openAround: source returns a batch that does not contain the target → safe no-op (no mount, no crash)', async () => {
    const { hooks } = controllableHooks();
    const src: CbSource<number> = {
      init: async () => [{ id: 1, data: 1 }, { id: 2, data: 2 }],
      getOlder: async () => [], getNewer: async () => [],
      pushLive: () => {}, getPending: () => [], destroy: () => {},
    };
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    scroller.scrollToIndex(999, 'center');
    await flush();
    expect(scroller.getInfo().mounted).toBe(0);
  });

  it('two consecutive jumps → gen guard: the in-flight first one is dropped, the final window centers on the second', async () => {
    const { hooks } = controllableHooks();
    const src = controllableInitSource(5000);
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    scroller.scrollToIndex(100, 'center'); // openAround#1 (gen=1)
    scroller.scrollToIndex(200, 'center'); // openAround#2 (++gen=2)
    expect(src.initPending()).toBe(2);
    src.resolveInit(src.batchAround(100)); // #1 → gen mismatch → dropped
    src.resolveInit(src.batchAround(200)); // #2 → mounts 151..250
    await flush();
    const info = scroller.getInfo();
    expect(info.oldestId).toBe(151);
    expect(info.newestId).toBe(250);
  });

  // ── insertAfter: mid-range insert (does not trigger balance; Plan A does not compensate scrollTop — key difference from B) ──

  it('insertAfter unmounted id → no-op (returns false, no mount, no load)', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    const mountedBefore = scroller.getInfo().mounted;
    const ok = scroller.insertAfter(9999, { id: -1, data: -1 });
    expect(ok).toBe(false);
    expect(scroller.getInfo().mounted).toBe(mountedBefore);
    expect(content.querySelector('[data-cb-id="-1"]')).toBeNull();
    expect(src.gets()).toBe(0);
    expect(src.newers()).toBe(0);
  });

  it('insertAfter mid-range → mounts at the correct DOM position idx+1 (between target and successor)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // m-400..m-499
    const mountedBefore = scroller.getInfo().mounted;
    const ok = scroller.insertAfter(450, { id: -1, data: -1 });
    expect(ok).toBe(true);
    expect(scroller.getInfo().mounted).toBe(mountedBefore + 1);
    const ids = Array.from(content.children).map(c => (c as HTMLElement).dataset['cbId']);
    const i = ids.indexOf('450');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(ids[i + 1]).toBe('-1');
    expect(ids[i + 2]).toBe('451');
  });

  it('insertAfter rebuilds the successor with the new prev; the new item is created once with target as prev', async () => {
    const calls: { id: number; prev: number | null }[] = [];
    const hooks = {
      createItem: (item: CbItem<number>, prev: CbItem<number> | null): CbElement<number> => {
        const id = String(item.id);
        calls.push({ id: item.id, prev: prev ? prev.id : null });
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => 100 });
        return { el, onHeightChange: () => () => ({}), update: () => {}, destroy: () => {} };
      },
    };
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    scroller.insertAfter(450, { id: -1, data: -1 });
    const ins = calls.filter(c => c.id === -1);
    expect(ins.length).toBe(1);
    expect(ins[0].prev).toBe(450);
    const succ = calls.filter(c => c.id === 451);
    expect(succ.length).toBe(2);         // init mount + rebuild
    expect(succ[1].prev).toBe(-1);    // rebuilt with the new prev
  });

  it('Plan A: insertAbove does not compensate scrollTop even above the fold (browser overflow-anchor owns it; under mock this means "unchanged")', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    await scroller.init(); // pinned to bottom (scrollTop=9400); m-400 (top 0) is above the fold
    const stBefore = viewport.scrollTop;
    const ok = scroller.insertAfter(400, { id: -1, data: -1 });
    expect(ok).toBe(true);
    expect(viewport.scrollTop).toBe(stBefore); // Plan A does not compensate (unlike B's +=100)
    expect(src.gets()).toBe(0);                 // does not trigger balance
    expect(src.newers()).toBe(0);
  });

  it('cursor guard: a transient reaching the tail does not pollute loadNewer (does not falsely lock noNewer)', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    viewport.scrollTop = 0; // scroll up → trimNewer → noNewer=false
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    const tailId = scroller.getInfo().newestId!;
    const ok = scroller.insertAfter(tailId, { id: -1, data: -1 }); // transient becomes the new tail
    expect(ok).toBe(true);
    expect(scroller.getInfo().newestId).toBe(-1);
    // drain the cb-enter so the checkpoint is not deferred when scrolling to the bottom edge
    content.querySelector<HTMLElement>('[data-cb-id="-1"]')?.dispatchEvent(new Event('animationend'));
    viewport.scrollTop = content.scrollHeight - 600; // scroll to the bottom edge → loadNewer
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.newers()).toBeGreaterThan(0);                      // getNewer called with the real cursor (skipped the transient)
    expect(scroller.getInfo().newestId).toBe(-1);              // transient stays at the tail (reals insert before the tail block)
    expect(scroller.getInfo().noNewer).toBe(false);               // NOT falsely locked (would be true without the guard)
    // reals were loaded before the transient: the item just newer than the original tail is now mounted
    expect(content.querySelector(`[data-cb-id="${tailId + 1}"]`)).not.toBeNull();
  });

  // ── Phase A/B/C (Plan A mirror): enter animation, transient-safe trim, settle, removeItem (no scrollTop compensation) ──

  /** Dispatch animationend on a host (drain cb-enter/cb-leave synchronously in tests). */
  function animEnd(id: string): void {
    content.querySelector<HTMLElement>(`[data-cb-id="${id}"]`)?.dispatchEvent(new Event('animationend'));
  }

  it('Phase A: insertAfter plays cb-enter; init/loadOlder mounts do not', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(content.querySelectorAll('.cb-enter').length).toBe(0);
    scroller.insertAfter(450, { id: -1, data: -1 });
    expect(content.querySelector<HTMLElement>('[data-cb-id="-1"]')?.classList.contains('cb-enter')).toBe(true);
    animEnd('-1');
    expect(content.querySelector<HTMLElement>('[data-cb-id="-1"]')?.classList.contains('cb-enter')).toBe(false);
  });

  it('Phase A: trimNewer skips a transient at the tail (in-flight optimistic survives loadOlder)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    scroller.insertAfter(499, { id: -1, data: -1 });
    animEnd('-1');
    await flush();
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().newestId).toBe(-1);
    expect(content.querySelector('[data-cb-id="-1"]')).not.toBeNull();
  });

  it('Phase B: appendLive dedups an item matching a mounted optimistic (no duplicate mount)', async () => {
    const { hooks } = controllableHooks();
    const base = fakeSource(500);
    const src: CbSource<number> = { ...base, pushLive: () => {} };
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    const mountedBefore = scroller.getInfo().mounted;
    scroller.insertAfter(499, { id: -1, data: -1 }, { optimistic: true });
    animEnd('-1');
    scroller.appendLive([{ id: -1, data: 777 }]); // same id → dedup skips
    await flush();
    expect(scroller.getInfo().mounted).toBe(mountedBefore + 1); // no duplicate
    expect(content.querySelector('[data-cb-id="-1"]')).not.toBeNull();
  });

  it('onMessageSignal reconciles an optimistic send into its confirmed real (no duplicate, real revealed)', async () => {
    const { hooks } = controllableHooks();
    // The real confirm carries a FRESH server id + the SAME clientMessageId as the optimistic (reconcile key).
    const base = fakeSource(500);
    const src: CbSource<number> = { ...base, getNewer: async () => [{ id: 600, data: 777, clientMessageId: 'cid-0', boundary: 'newest' as const }], pushLive: () => {} };
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    const mountedBefore = scroller.getInfo().mounted;
    scroller.insertAfter(499, { id: -1, data: -1, clientMessageId: 'cid-0' }, { optimistic: true });
    animEnd('-1');
    expect(scroller.getInfo().mounted).toBe(mountedBefore + 1);
    const p = scroller.onMessageSignal();
    await flush(); // loadNewer mounts the real; reconcile is synchronous (no slide to drain)
    await p;
    await flush();
    expect(content.querySelectorAll('[data-cb-id="-1"]').length).toBe(0); // optimistic removed
    expect(content.querySelectorAll('[data-cb-id="600"]').length).toBe(1);    // real revealed
    expect(content.querySelector('[data-cb-id="600"]')?.classList.contains('cb-confirmed')).toBe(true); // real tagged cb-confirmed
  });

  // confirmPending parity with ChatBoxScroller: the decoupled delivery-confirm path (HTTP 200 / upload success)
  // morphs the OPTIMISTIC in place + tags cb-confirmed, with no remount and no FLIP. Single-trigger (play once).
  it('confirmPending: morphs the optimistic in place (update, no remount) + tags cb-confirmed, no FLIP', async () => {
    const t = trackingHooks();
    const base = fakeSource(500);
    const sent: CbItem<number> = { id: -1, clientMessageId: 'cid-cp', data: 999 };
    const src: CbSource<number> = { ...base, getPending: () => [sent] };
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks: t.hooks, source: src });
    await scroller.init();
    scroller.insertAfter(499, { id: -1, data: -1, clientMessageId: 'cid-cp' }, { optimistic: true });
    animEnd('-1');
    await flush();

    const elBefore = content.querySelector('[data-cb-id="-1"]');
    const createsBefore = t.createCount();
    const updatesBefore = t.updateCount();

    scroller.confirmPending('cid-cp');
    await flush();

    expect(content.querySelector('[data-cb-id="-1"]')).toBe(elBefore);   // same element — in place, no remount
    expect(elBefore?.classList.contains('cb-confirmed')).toBe(true);
    expect(t.createCount()).toBe(createsBefore);                         // no recreate
    expect(t.updateCount()).toBe(updatesBefore + 1);                     // fresh snapshot via update
    expect(t.dataOf(-1)).toBe(999);
    expect(content.querySelectorAll('[data-cb-id="-1"]').length).toBe(1);
    expect(elBefore?.classList.contains('cb-move')).toBe(false);         // no FLIP — decoupled from the reorder
  });

  it('confirmPending: no-op when no optimistic matches the cid (SSE echo already swapped it out)', async () => {
    const t = trackingHooks();
    const base = fakeSource(500);
    const src: CbSource<number> = { ...base, getPending: () => [] };
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks: t.hooks, source: src });
    await scroller.init();
    const updatesBefore = t.updateCount();
    scroller.confirmPending('cid-absent');
    await flush();
    expect(t.updateCount()).toBe(updatesBefore);
    expect(content.querySelector('[data-cb-id="-1"]')).toBeNull();
  });

  it('confirmPending: play once — a second call on an already-confirmed entry does NOT re-morph', async () => {
    const t = trackingHooks();
    const base = fakeSource(500);
    let sent: CbItem<number> = { id: -1, clientMessageId: 'cid-once', data: 111 };
    const src: CbSource<number> = { ...base, getPending: () => [sent] };
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks: t.hooks, source: src });
    await scroller.init();
    scroller.insertAfter(499, { id: -1, data: -1, clientMessageId: 'cid-once' }, { optimistic: true });
    animEnd('-1');
    await flush();

    scroller.confirmPending('cid-once');
    await flush();
    const updatesAfterFirst = t.updateCount();
    sent = { id: -1, clientMessageId: 'cid-once', data: 222 };
    scroller.confirmPending('cid-once');                                // already cb-confirmed → guard returns
    await flush();
    expect(t.updateCount()).toBe(updatesAfterFirst);                    // no second morph — the lock held
    expect(t.dataOf(-1)).toBe(111);
  });

  it('Phase C: removeItem(mountedId) plays cb-leave then unmounts on animationend; returns 1', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const mountedBefore = scroller.getInfo().mounted;
    expect(scroller.removeItem(450)).toBe(1);
    expect(content.querySelector<HTMLElement>('[data-cb-id="450"]')?.classList.contains('cb-leave')).toBe(true);
    expect(scroller.getInfo().mounted).toBe(mountedBefore); // still mounted during the animation
    animEnd('450');
    await flush();
    expect(scroller.getInfo().mounted).toBe(mountedBefore - 1);
    expect(content.querySelector('[data-cb-id="450"]')).toBeNull();
  });

  it('Phase C: removeItem(array) removes multiple concurrently; not-mounted id contributes 0', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const mountedBefore = scroller.getInfo().mounted;
    expect(scroller.removeItem([450, 9999])).toBe(1); // only 450 mounted
    animEnd('450');
    await flush();
    expect(scroller.getInfo().mounted).toBe(mountedBefore - 1);
  });

  it('Phase C (Plan A): removeItem does NOT compensate scrollTop (browser overflow-anchor owns the viewport)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const stBefore = viewport.scrollTop;
    scroller.removeItem(400); // above the fold — Plan A leaves scrollTop untouched
    animEnd('400');
    await flush();
    expect(viewport.scrollTop).toBe(stBefore);
  });

  it('Phase C: while a cb-leave is in flight, balance is deferred; it resumes on animationend', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    const getsBefore = src.gets();
    scroller.removeItem(400);
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.gets()).toBe(getsBefore); // deferred (animating>0)
    animEnd('400');
    await flush();
    expect(src.gets()).toBeGreaterThan(getsBefore); // resumed
  });

  // ── Tail cap: persistent non-message element at the newer edge (mirrors the top ghost; never in mounted[]) ──

  it('tail cap: always the last child of content, exactly one, after init', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const caps = content.querySelectorAll('.cb-tail-cap');
    expect(caps.length).toBe(1);
    expect(content.lastElementChild).toBe(caps[0]); // always last: every append inserts before it
  });

  it('tail cap: gap mode at the global newest (noNewer) — cb-tail-cap--gap, height measured + folded into totalH', async () => {
    const { hooks } = controllableHooks(); // 100px/item
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
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
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 2500, anchor: 'center' }); // mid-history → noNewer=false
    expect(scroller.getInfo().noNewer).toBe(false);
    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    expect(cap.classList.contains('cb-tail-cap--loading')).toBe(true);
    expect(cap.classList.contains('cb-tail-cap--gap')).toBe(false);
    expect(cap.offsetHeight).toBe(48); // same row height as the top ghost spinner
  });

  it('tail cap: loading→gap when scrollToBottom reaches the global newest (re-measured on the reaching batch)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // noNewer=true → gap
    scroller.scrollToIndex(100, 'center'); // re-seed mid-history → noNewer=false → loading
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    expect(content.querySelector('.cb-tail-cap')!.classList.contains('cb-tail-cap--loading')).toBe(true);
    scroller.scrollToBottom(); // chains (loadNewer→scrollToBottom) to the global newest
    await flush();
    expect(scroller.getInfo().noNewer).toBe(true);
    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    expect(cap.classList.contains('cb-tail-cap--gap')).toBe(true);
    expect(cap.offsetHeight).toBe(14); // height re-measured 48→14 on the batch that reached newest
  });

  it('tail cap: never in mounted[] — newestId is the last real item, the cap carries no data-cb-id', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    expect(cap.dataset['cbId']).toBeUndefined();        // not a rendered item → no cursor corruption
    expect(scroller.getInfo().newestId).toBe(499);  // cursor is the last REAL item, never the cap
  });

  it('tail cap: persists across a re-seed (unmountAll keeps it; still exactly one after a jump)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init();
    expect(content.querySelectorAll('.cb-tail-cap').length).toBe(1);
    scroller.scrollToIndex(100, 'center'); // re-seed: unmountAll does NOT remove the cap
    await flush();
    expect(content.querySelectorAll('.cb-tail-cap').length).toBe(1); // reused, not duplicated
    expect(content.lastElementChild?.classList.contains('cb-tail-cap')).toBe(true);
  });

  it('tail cap: optimistic insert at the tail while noNewer stays gap (no phantom spinner under a sent message)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // noNewer=true
    scroller.insertAfter(499, { id: -1, data: -1 }); // transient inserted before the cap
    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    expect(cap.classList.contains('cb-tail-cap--gap')).toBe(true); // still gap, NOT loading
    expect(content.lastElementChild).toBe(cap);                    // cap still last
    expect(content.querySelector('[data-cb-id="-1"]')?.nextElementSibling).toBe(cap); // transient before the cap
  });

  it('tail cap: destroy removes it (content fully empty)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(content.querySelector('.cb-tail-cap')).not.toBeNull();
    scroller.destroy();
    expect(content.querySelectorAll('.cb-tail-cap').length).toBe(0);
    expect(content.children.length).toBe(0);
  });

  // ── reconcilePending: in-place failure morph + FLIP reorder (sending→failed, sink to tail, stable clientMessageId) ──

  it('reconcilePending morphs a failed send IN PLACE (same node, update not recreate, no cb-leave/cb-enter)', async () => {
    const t = trackingHooks();
    const pending: CbItem<number>[] = [];
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks: t.hooks, source: pendingSource(500, pending) });
    await scroller.init();
    const opt: CbItem<number> = { id: -1, data: 1, clientMessageId: 'cid-0' };
    pending.push(opt);
    scroller.insertAfter(499, opt, { optimistic: true });
    animEnd('-1');
    const elBefore = content.querySelector('[data-cb-id="-1"]');
    const mountedBefore = scroller.getInfo().mounted;
    const createsBefore = t.createCount();
    const updatesBefore = t.updateCount();

    pending[0] = { id: -1, data: 2, clientMessageId: 'cid-0' }; // source flips status (new data ref, same id)
    await scroller.reconcilePending();

    expect(content.querySelector('[data-cb-id="-1"]')).toBe(elBefore);
    expect(t.createCount()).toBe(createsBefore);
    expect(t.updateCount()).toBe(updatesBefore + 1);
    expect(t.dataOf(-1)).toBe(2);
    expect(scroller.getInfo().mounted).toBe(mountedBefore);
    expect(content.querySelector('[data-cb-id="-1"]')?.classList.contains('cb-move')).toBe(false);
  });

  it('reconcilePending FLIP-reorders a failed send to the tail; the shoved sibling animates too', async () => {
    const { hooks } = controllableHooks();
    const pending: CbItem<number>[] = [];
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: pendingSource(500, pending) });
    await scroller.init();
    const A: CbItem<number> = { id: -1, data: 10, clientMessageId: 'cid-A' };
    const B: CbItem<number> = { id: -2, data: 20, clientMessageId: 'cid-B' };
    pending.push(A, B);
    scroller.insertAfter(499, A, { optimistic: true });
    animEnd('-1');
    scroller.insertAfter(-1, B, { optimistic: true });
    animEnd('-2');
    pending.splice(0, 2, { id: -2, data: 20, clientMessageId: 'cid-B' }, { id: -1, data: 11, clientMessageId: 'cid-A' });
    await scroller.reconcilePending();

    const ids = Array.from(content.children).filter(c => (c as HTMLElement).dataset['cbId']).map(c => (c as HTMLElement).dataset['cbId'] as string);
    const i = ids.lastIndexOf('499');
    expect(ids.slice(i + 1)).toEqual(['-2', '-1']);
    expect(content.querySelector('[data-cb-id="-1"]')?.classList.contains('cb-move')).toBe(true);
    expect(content.querySelector('[data-cb-id="-2"]')?.classList.contains('cb-move')).toBe(true);
    animEnd('-1'); animEnd('-2');
    expect(content.querySelector('[data-cb-id="-1"]')?.classList.contains('cb-move')).toBe(false);
    expect(content.querySelector('[data-cb-id="-2"]')?.classList.contains('cb-move')).toBe(false);
  });

  it('reconcilePending morphs a retried send back in place at its position (no remount, no move)', async () => {
    const t = trackingHooks();
    const pending: CbItem<number>[] = [];
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks: t.hooks, source: pendingSource(500, pending) });
    await scroller.init();
    pending.push({ id: -1, data: 10, clientMessageId: 'cid-A' });
    scroller.insertAfter(499, pending[0], { optimistic: true });
    animEnd('-1');
    pending[0] = { id: -1, data: 11, clientMessageId: 'cid-A' };
    await scroller.reconcilePending();
    animEnd('-1');
    const elFailed = content.querySelector('[data-cb-id="-1"]');
    const createsBeforeRetry = t.createCount();

    pending[0] = { id: -1, data: 12, clientMessageId: 'cid-A' };
    await scroller.reconcilePending();

    expect(content.querySelector('[data-cb-id="-1"]')).toBe(elFailed);
    expect(t.createCount()).toBe(createsBeforeRetry);
    expect(content.querySelector('[data-cb-id="-1"]')?.classList.contains('cb-move')).toBe(false);
    expect(t.dataOf(-1)).toBe(12);
  });

  it('destroy during a FLIP move drains cleanly (moveTimer cleared, animating not leaked)', async () => {
    const { hooks } = controllableHooks();
    const pending: CbItem<number>[] = [];
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: pendingSource(500, pending) });
    await scroller.init();
    pending.push({ id: -1, data: 10, clientMessageId: 'cid-A' }, { id: -2, data: 20, clientMessageId: 'cid-B' });
    scroller.insertAfter(499, pending[0], { optimistic: true });
    animEnd('-1');
    scroller.insertAfter(-1, pending[1], { optimistic: true });
    animEnd('-2');
    pending.splice(0, 2, { id: -2, data: 20, clientMessageId: 'cid-B' }, { id: -1, data: 11, clientMessageId: 'cid-A' });
    await scroller.reconcilePending();
    expect(content.querySelector('[data-cb-id="-1"]')?.classList.contains('cb-move')).toBe(true);
    expect(() => scroller?.destroy()).not.toThrow();
    scroller = undefined;
  });
});
