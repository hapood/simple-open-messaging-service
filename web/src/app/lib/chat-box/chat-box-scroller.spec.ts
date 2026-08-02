/**
 * ChatBoxScroller (manual anchor · array index) unit tests.
 *
 * The kernel is framework-agnostic and only interacts via the CbElement + CbSource interfaces, so the tests drive it
 * with mocks:
 *  - controllableHooks: a real div + Object.defineProperty(offsetHeight), createItem(item, prev).
 *  - fakeSource: N msgs (0 oldest .. N-1 newest), cursor getOlder/getNewer, ascending return.
 * content.scrollHeight / viewport.clientHeight / scrollTop are fixed via getter/setter; RAF is mocked synchronous.
 *
 * Focus: manual scrollTop compensation (viewport does not jump after loadOlder prepend), ghost rebuild (createItem
 * re-invoked with the new prev), and phase-0 noOlder absorb timing. The msgId cursor verifies that the kernel index is
 * decoupled from the source id.
 */
import { ChatBoxScroller, CbElement, CbItem } from './chat-box-scroller';
import type { CbDemand, CbDemandResult, CbSource } from './cb-source';
import { Observable, of, type Subscriber } from 'rxjs';

function testDemand<T>(
  work: () => Promise<CbItem<T>[]>,
  boundaryOnEmpty = false,
): CbDemand<T> {
  return new Observable((subscriber) => {
    void work().then((items) => {
      if (subscriber.closed || (items.length === 0 && !boundaryOnEmpty)) return;
      subscriber.next(
        items.length > 0 ? { kind: 'items', items } : { kind: 'boundary' },
      );
      subscriber.complete();
    });
  });
}

function sumChildrenHeight(el: HTMLElement): number {
  let s = 0;
  for (const c of Array.from(el.children))
    s += (c as HTMLElement).offsetHeight || 0;
  return s;
}

/** Controllable hooks: createItem(item, prev), fixed height per item (mutable later via setHeight). msgId is the Map key. */
function controllableHooks(itemHeight = 100): {
  hooks: {
    createItem: (
      item: CbItem<number>,
      prev: CbItem<number> | null,
    ) => CbElement<number>;
  };
  setHeight: (id: number, h: number) => void;
} {
  const cbs = new Map<string, (h: number) => void>();
  const heights = new Map<string, number>();
  const h0 = (id: string) => heights.get(id) ?? itemHeight;
  return {
    hooks: {
      createItem: (item): CbElement<number> => {
        const id = String(item.id);
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', {
          configurable: true,
          get: () => h0(id),
        });
        return {
          el,
          onHeightChange: (cb) => {
            cbs.set(id, cb);
            return () => {
              cbs.delete(id);
            };
          },
          update: () => {},
          destroy: () => {},
        };
      },
    },
    setHeight: (id: number, h: number) => {
      const key = String(id);
      heights.set(key, h);
      cbs.get(key)?.(h);
    },
  };
}

/** Hooks that supply a createSkeleton (a distinct .cb-ghost-loading spinner element), so skeleton-slot DOM is observable
 *  separate from real items. Needed to surface a stuck-spinner bug: a skeleton slot whose DOM is never rebuilt stays a
 *  spinner mid-list. Real items render via createItem (class 'real'); skeleton slots via createSkeleton (class
 *  'cb-ghost-loading'). Both carry a fixed measured height. */
function skeletonHooks(
  itemHeight = 40,
  ghostHeight = 48,
): {
  hooks: {
    createItem: (
      item: CbItem<number>,
      prev: CbItem<number> | null,
    ) => CbElement<number>;
    createSkeleton: (item: CbItem<number>) => CbElement<number>;
  };
} {
  const makeEl = (cls: string, h: number) => {
    const el = document.createElement('div');
    el.className = cls;
    Object.defineProperty(el, 'offsetHeight', {
      configurable: true,
      get: () => h,
    });
    return el;
  };
  return {
    hooks: {
      createItem: () => ({
        el: makeEl('real', itemHeight),
        onHeightChange: () => () => {},
        update: () => {},
        destroy: () => {},
      }),
      createSkeleton: () => ({
        el: makeEl('cb-ghost-loading', ghostHeight),
        onHeightChange: () => () => {},
        update: () => {},
        destroy: () => {},
      }),
    },
  };
}

/** Hooks that record each createItem's (id, prev.id) — verifies ghost rebuild re-invokes createItem with the new prev. */
function recordingHooks(itemHeight = 100): {
  hooks: {
    createItem: (
      item: CbItem<number>,
      prev: CbItem<number> | null,
    ) => CbElement<number>;
  };
  calls: { id: number; prev: number | null }[];
} {
  const calls: { id: number; prev: number | null }[] = [];
  return {
    hooks: {
      createItem: (item, prev): CbElement<number> => {
        calls.push({ id: item.id, prev: prev ? prev.id : null });
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', {
          configurable: true,
          get: () => itemHeight,
        });
        return {
          el,
          onHeightChange: () => () => {},
          update: () => {},
          destroy: () => {},
        };
      },
    },
    calls,
  };
}

/** Hooks that record createItem vs update so reconcilePending tests can assert in-place morph (update, NOT recreate).
 *  Tracks the latest data applied per id through EITHER path (create or update). Fixed height (no morph delta). */
function trackingHooks(itemHeight = 100): {
  hooks: {
    createItem: (
      item: CbItem<number>,
      prev: CbItem<number> | null,
    ) => CbElement<number>;
  };
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
        Object.defineProperty(el, 'offsetHeight', {
          configurable: true,
          get: () => itemHeight,
        });
        return {
          el,
          onHeightChange: () => () => {},
          update: (next) => {
            updates++;
            dataMap.set(id, next.data);
          },
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
function pendingSource(
  total: number,
  pending: CbItem<number>[],
): CbSource<number> {
  return { ...fakeSource(total), getPending: () => pending.slice() };
}

/** Live-caching source (mirrors MockItemSource's live path), unlike fakeSource whose pushLive is cache-only and
 *  never returns the items. pushLive appends to `live`; getNewer returns all live items newer than a full cursor
 *  (ascending, the last tagged 'newest' — the global newest moves with each push). init/getOlder operate on a static
 *  `full` (0 oldest .. N-1 newest). For signal-path / async-height-settle tests. */
function liveSource(N: number): CbSource<number> & { live: CbItem<number>[] } {
  const itemAt = (i: number): CbItem<number> | undefined => {
    if (i < 0 || i >= N) return undefined;
    const boundary =
      i === 0
        ? ('oldest' as const)
        : i === N - 1
          ? ('newest' as const)
          : undefined;
    return boundary ? { id: i, data: i, boundary } : { id: i, data: i };
  };
  const slice = (lo: number, hi: number): CbItem<number>[] => {
    const out: CbItem<number>[] = [];
    for (let i = Math.max(0, lo); i < Math.min(N, hi); i++) {
      const it = itemAt(i);
      if (it) out.push(it);
    }
    return out;
  };
  const live: CbItem<number>[] = [];
  const newerWaiters = new Set<{
    cursorId: number;
    count: number;
    subscriber: Subscriber<CbDemandResult<number>>;
  }>();
  const itemsAfter = (cursorId: number, count: number): CbItem<number>[] =>
    live.filter((item) => item.id > cursorId).slice(0, count);
  const pumpNewer = (): void => {
    for (const waiter of Array.from(newerWaiters)) {
      const items = itemsAfter(waiter.cursorId, waiter.count);
      if (items.length === 0) continue;
      newerWaiters.delete(waiter);
      waiter.subscriber.next({ kind: 'items', items });
      waiter.subscriber.complete();
    }
  };
  const src: CbSource<number> = {
    init: async (anchorId, olderCount) => {
      if (anchorId !== -1) return [];
      const start = Math.max(0, N - olderCount);
      const out = slice(start, N);
      if (out.length) {
        if (start === 0) out[0] = { ...out[0], boundary: 'oldest' };
        out[out.length - 1] = { ...out[out.length - 1], boundary: 'newest' };
      }
      return out;
    },
    requestOlder: (cursorId, count) =>
      testDemand(async () => {
        const k = cursorId;
        const out = slice(k - count, k);
        if (out.length && k - count <= 0)
          out[0] = { ...out[0], boundary: 'oldest' };
        return out;
      }, true),
    requestNewer: (cursorId, count) => {
      return new Observable((subscriber) => {
        const items = itemsAfter(cursorId, count);
        if (items.length > 0) {
          subscriber.next({ kind: 'items', items });
          subscriber.complete();
          return undefined;
        }
        const waiter = { cursorId, count, subscriber };
        newerWaiters.add(waiter);
        return () => {
          newerWaiters.delete(waiter);
        };
      });
    },
    pushLive: (items) => {
      for (const it of items) live.push(it);
      pumpNewer();
    },
    getPending: () => [],
    destroy: () => {},
  };
  return Object.assign(src, { live });
}

/** Source-driven live updates for kernel tests. requestNewer stays pending until pushLive makes
 * matching cached items available, mirroring HttpItemSource's long-lived newer demand. */
function pushedSource(base: CbSource<number>): CbSource<number> {
  const live: CbItem<number>[] = [];
  let newerHighWater = -Infinity;
  const waiters = new Set<{
    cursorId: number;
    count: number;
    subscriber: Subscriber<CbDemandResult<number>>;
  }>();
  const available = (cursorId: number, count: number) =>
    live
      .filter((item) => item.id > Math.max(cursorId, newerHighWater))
      .slice(0, count);
  const isReady = (items: CbItem<number>[], count: number) =>
    items.length >= count ||
    items.some(
      (item) => item.boundary === 'newest' || item.boundary === 'both',
    );
  const pump = () => {
    for (const waiter of Array.from(waiters)) {
      const items = available(waiter.cursorId, waiter.count);
      if (!isReady(items, waiter.count)) continue;
      waiters.delete(waiter);
      newerHighWater = Math.max(
        newerHighWater,
        ...items.map((item) => item.id),
      );
      waiter.subscriber.next({ kind: 'items', items });
      waiter.subscriber.complete();
    }
  };
  return {
    ...base,
    requestNewer: (cursorId, count) => {
      return new Observable((subscriber) => {
        const items = available(cursorId, count);
        if (isReady(items, count)) {
          newerHighWater = Math.max(
            newerHighWater,
            ...items.map((item) => item.id),
          );
          subscriber.next({ kind: 'items', items });
          subscriber.complete();
          return undefined;
        } else {
          const waiter = { cursorId, count, subscriber };
          waiters.add(waiter);
          return () => {
            waiters.delete(waiter);
          };
        }
      });
    },
    pushLive: (items) => {
      live.push(...items);
      pump();
    },
  };
}

/** Fake source: N msgs (0 oldest .. N-1 newest). Cursor getOlder/getNewer, ascending return. */
function fakeSource(
  N: number,
): CbSource<number> & { gets: () => number; newers: () => number } {
  const itemAt = (i: number): CbItem<number> | undefined => {
    if (i < 0 || i >= N) return undefined;
    const boundary =
      i === 0
        ? ('oldest' as const)
        : i === N - 1
          ? ('newest' as const)
          : undefined;
    return boundary ? { id: i, data: i, boundary } : { id: i, data: i };
  };
  const slice = (lo: number, hi: number): CbItem<number>[] => {
    const out: CbItem<number>[] = [];
    for (let i = Math.max(0, lo); i < Math.min(N, hi); i++) {
      const it = itemAt(i);
      if (it) out.push(it);
    }
    return out;
  };
  let gets = 0;
  let newers = 0;
  const src: CbSource<number> = {
    init: async (anchorId, older, newer) => {
      if (anchorId === -1) return slice(N - older, N); // anchor = newest
      const idx = anchorId; // real msgId: bidirectional fetch (mirrors MockItemSource)
      if (idx < 0 || idx >= N) return [];
      const olderStart = Math.max(0, idx - older + 1);
      const newerEnd = Math.min(N, idx + 1 + newer);
      return [...slice(olderStart, idx + 1), ...slice(idx + 1, newerEnd)];
    },
    requestOlder: (cursorId, count) =>
      testDemand(async () => {
        gets++;
        const k = cursorId;
        return slice(k - count, k);
      }, true),
    requestNewer: (cursorId, count) =>
      testDemand(async () => {
        newers++;
        const k = cursorId;
        return slice(k + 1, k + 1 + count);
      }),
    pushLive: (_items) => {
      /* cache-only: direct-mount path mounts the raw items; the signal path uses getNewer */
    },
    getPending: () => [],
    destroy: () => {},
  };
  return Object.assign(src, { gets: () => gets, newers: () => newers });
}

/** Controllable-init source: init returns a manually-resolved Promise (tests consecutive-jump gen overtake: in-flight jump dropped). */
function controllableInitSource(N: number): CbSource<number> & {
  resolveInit: (items: CbItem<number>[]) => void;
  initPending: () => number;
  batchAround: (k: number) => CbItem<number>[];
} {
  const itemAt = (i: number): CbItem<number> | undefined => {
    if (i < 0 || i >= N) return undefined;
    const boundary =
      i === 0
        ? ('oldest' as const)
        : i === N - 1
          ? ('newest' as const)
          : undefined;
    return boundary ? { id: i, data: i, boundary } : { id: i, data: i };
  };
  const slice = (lo: number, hi: number): CbItem<number>[] => {
    const out: CbItem<number>[] = [];
    for (let i = Math.max(0, lo); i < Math.min(N, hi); i++) {
      const it = itemAt(i);
      if (it) out.push(it);
    }
    return out;
  };
  const queue: ((items: CbItem<number>[]) => void)[] = [];
  const src: CbSource<number> = {
    init: () =>
      new Promise<CbItem<number>[]>((resolve) => {
        queue.push(resolve);
      }),
    requestOlder: (c, k) =>
      testDemand(async () => {
        const i = c;
        return slice(i - k, i);
      }, true),
    requestNewer: (c, k) =>
      testDemand(async () => {
        const i = c;
        return slice(i + 1, i + 1 + k);
      }),
    pushLive: (_items) => {
      /* cache-only: direct-mount path mounts the raw items; the signal path uses getNewer */
    },
    getPending: () => [],
    destroy: () => {},
  };
  return Object.assign(src, {
    resolveInit: (items: CbItem<number>[]) => {
      const r = queue.shift();
      if (r) r(items);
    },
    initPending: () => queue.length,
    batchAround: (k: number) => [
      ...slice(Math.max(0, k - 49), k + 1),
      ...slice(k + 1, k + 51),
    ],
  });
}

/** Controllable source: getOlder returns a manually-resolved Promise, to test changing scrollTop while getOlder is in flight (reverse fling). */
function controllableSource(N: number): CbSource<number> & {
  gets: () => number;
  resolveOlder: (items?: CbItem<number>[]) => void;
  isPending: () => boolean;
} {
  const itemAt = (i: number): CbItem<number> | undefined => {
    if (i < 0 || i >= N) return undefined;
    const boundary =
      i === 0
        ? ('oldest' as const)
        : i === N - 1
          ? ('newest' as const)
          : undefined;
    return boundary ? { id: i, data: i, boundary } : { id: i, data: i };
  };
  const slice = (lo: number, hi: number): CbItem<number>[] => {
    const out: CbItem<number>[] = [];
    for (let i = Math.max(0, lo); i < Math.min(N, hi); i++) {
      const it = itemAt(i);
      if (it) out.push(it);
    }
    return out;
  };
  let resolver: ((items?: CbItem<number>[]) => void) | null = null;
  let pendingRange = { lo: 0, hi: 0 };
  let gets = 0;
  const src: CbSource<number> = {
    init: async (_r, older) => slice(N - older, N),
    requestOlder: function (cursorId, count) {
      gets++;
      const k = cursorId;
      pendingRange = { lo: k - count, hi: k };
      return testDemand(
        () =>
          new Promise((resolve) => {
            resolver = (items?: CbItem<number>[]) =>
              resolve(items ?? slice(pendingRange.lo, pendingRange.hi));
          }),
        true,
      );
    },
    requestNewer: (cursorId, count) =>
      testDemand(async () => {
        const k = cursorId;
        return slice(k + 1, k + 1 + count);
      }),
    pushLive: (_items) => {
      /* cache-only: direct-mount path mounts the raw items; the signal path uses getNewer */
    },
    getPending: () => [],
    destroy: () => {},
  };
  return Object.assign(src, {
    gets: () => gets,
    resolveOlder: (items?: CbItem<number>[]) => {
      if (resolver) {
        const r = resolver;
        resolver = null;
        r(items);
      }
    },
    isPending: () => resolver !== null,
  });
}

/** Drain microtasks (openAround/fillAround multi-hop async await): scrollToIndex is fire-and-forget, so flush manually. */
async function flush(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** Wait for an observable kernel/source condition instead of guessing how many async hops it needs. */
async function waitFor(
  condition: () => boolean,
  description: string,
  maxTurns = 200,
): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn++) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/** Replace the viewport's fixed clientHeight getter with a mutable one (simulate a viewport shrink/grow, e.g. the soft
 *  keyboard opening/closing). Returns a setter. */
function mutableVh(
  viewport: HTMLDivElement,
  initial: number,
): { set: (v: number) => void } {
  let v = initial;
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    get: () => v,
  });
  return {
    set: (nv: number) => {
      v = nv;
    },
  };
}

/** Test seam: invoke the private viewport-resize handler directly (ResizeObserver cannot be driven from a getter-based
 *  clientHeight in the jsdom/Karma layout, so drive the handler the RO callback would call). */
function reflow(s: ChatBoxScroller<number>): void {
  (s as unknown as { onViewportResize: () => void }).onViewportResize();
}

type EdgeStateView = {
  active: object | null;
  error: unknown | null;
  retrying: boolean;
};

function edgeState(
  s: ChatBoxScroller<number>,
  direction: 'older' | 'newer',
): EdgeStateView {
  return (s as unknown as Record<string, EdgeStateView>)[`${direction}Demand`];
}

function newestHighlightPending(s: ChatBoxScroller<number>): boolean {
  return (s as unknown as { highlightNewestWhenReached: boolean })
    .highlightNewestWhenReached;
}

describe('ChatBoxScroller (manual anchor · array index)', () => {
  let viewport: HTMLDivElement;
  let content: HTMLDivElement;
  let scroller: ChatBoxScroller<number> | undefined;
  let rafSpy: jasmine.Spy;

  beforeEach(() => {
    viewport = document.createElement('div');
    content = document.createElement('div');
    viewport.appendChild(content);
    document.body.appendChild(viewport);
    Object.defineProperty(viewport, 'clientHeight', {
      configurable: true,
      get: () => 600,
    });
    let st = 0;
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => st,
      set: (v: number) => {
        st = v;
      },
    });
    Object.defineProperty(content, 'scrollHeight', {
      configurable: true,
      get: () => sumChildrenHeight(content),
    });
    rafSpy = spyOn(window, 'requestAnimationFrame').and.callFake(
      (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      },
    );
  });

  afterEach(() => {
    scroller?.destroy();
    scroller = undefined;
    viewport.remove();
    rafSpy.and.callThrough?.();
  });

  it('init loads the newest batch, pins to bottom, window boundary msgIds correct', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    const info = scroller.getInfo();
    expect(info.mounted).toBe(100);
    expect(info.oldestId).toBe(400);
    expect(info.newestId).toBe(499);
    expect(info.atBottom).toBe(true);
    expect(info.noNewer).toBe(true); // boundary newest absorbed (anchor)
    expect(info.noOlder).toBe(false); // not yet at the oldest
  });

  it('non-empty init emits fully-visible entries without requiring a user scroll', async () => {
    const { hooks } = controllableHooks();
    const entered: number[] = [];
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(3),
      onFullyVisibleEnter: (entries) =>
        entered.push(...entries.map((entry) => entry.item.id)),
    });

    await scroller.init();

    expect(entered).toEqual([0, 1, 2]);
  });

  it('init does not mount rows when destroyed during the fetch (no orphan injection into reused content)', async () => {
    // Regression: init()'s normal path (startMsgId === null) awaits source.init() and once OMITTED the post-await
    // `destroyed` check that openAround already had. A coordinator teardown/re-init overtaking the fetch would
    // destroy() this scroller mid-flight; the dead scroller's init() then resumed and mountBatch()ed its batch into
    // the shared content element a NEWER scroller now owned — rows no live scroller tracked (orphans), inflating
    // scrollHeight past totalH and corrupting scroll anchoring. The fix mirrors openAround's guard; this pins it.
    const src = controllableInitSource(20);
    const { hooks } = controllableHooks(100);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    const p = scroller.init(); // startMsgId null → awaits the controllable init (pending)
    expect(src.initPending()).toBe(1);
    scroller.destroy(); // overtaken mid-fetch, exactly like teardownKernel/reset→reinit
    src.resolveInit(src.batchAround(10)); // fetch resolves → init() resumes past its await
    await p; // let the post-await continuation run
    expect(content.querySelectorAll('[data-cb-id]').length).toBe(0); // the dead scroller mounted NOTHING
  });

  it('unmountAll throws (dev) when content holds an untracked [data-cb-id] orphan', () => {
    // Pins the invariant guard: if any path ever leaves an orphan, the kernel must FAIL LOUD (throw) rather than
    // silently sweep — sweeping would leak the orphan host's Angular ref/ResizeObserver AND mask the root cause.
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(50),
    });
    const orphan = document.createElement('div');
    orphan.setAttribute('data-cb-id', '999'); // a kernel-tagged row the scroller never mounted/tracked
    content.appendChild(orphan);
    expect(() => scroller!.destroy()).toThrowError(/orphaned row/);
    orphan.remove(); // tidy the shared DOM; the instance is already dead (state set pre-throw)
    scroller = undefined; // skip afterEach's re-destroy
  });

  it('a signal in the init-fetch window is saved + replayed once after init (not dropped)', async () => {
    // Models the race: a message arrives DURING init's initial source.init(-1) HTTP fetch — it MISSES the
    // snapshot, so it's known only via its SSE signal. The source's init is deferred (the window) + it can
    // grow a newer id mid-flight. Before the fix, runMessageSignal's `!noNewer && !primed` branch DROPPED
    // this signal; now it's saved (coalesced) and init replays it once.
    let top = 99; // highest existing id; grows when a message "arrives"
    let resolveInitFn: ((items: CbItem<number>[]) => void) | null = null;
    let newerCalls = 0;
    const item = (i: number): CbItem<number> =>
      i === 0
        ? { id: i, data: i, boundary: 'oldest' }
        : i === top
          ? { id: i, data: i, boundary: 'newest' }
          : { id: i, data: i };
    const slice = (lo: number, hi: number): CbItem<number>[] => {
      const out: CbItem<number>[] = [];
      for (let i = Math.max(0, lo); i < Math.min(top + 1, hi); i++)
        out.push(item(i));
      return out;
    };
    const src: CbSource<number> = {
      init: (anchorId) =>
        anchorId === -1
          ? new Promise((r) => {
              resolveInitFn = r;
            })
          : Promise.resolve([]),
      requestOlder: () => testDemand(async () => [], true), // no older fill — keep the test focused on the init batch
      requestNewer: (c, k) =>
        testDemand(async () => {
          newerCalls++;
          return slice(c + 1, c + 1 + k);
        }),
      pushLive: () => {},
      getPending: () => [],
      destroy: () => {},
    };
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });

    const initP = scroller.init(); // bottom-pin: source.init(-1) deferred → the init-fetch window
    await flush();
    expect(resolveInitFn).not.toBeNull(); // init's initial fetch is still in flight

    // Snapshot taken BEFORE the arrival (ids 80..99, 99 = newest) — what init's query returned.
    const snapshot = slice(80, 100);
    expect(snapshot.at(-1)!.id).toBe(99);

    // A message (id 100) arrives during the window + its signal fires (would be DROPPED before the fix).
    top = 100;
    // The source's pending newer demand observes the arrival directly.

    // init resolves with the pre-arrival snapshot (id 100 missed it).
    resolveInitFn!(snapshot);
    resolveInitFn = null;
    await initP;
    await flush();

    // The saved signal was replayed once init primed → loadNewer → getNewer → id 100 mounted (recovered).
    expect(newerCalls).toBeGreaterThanOrEqual(1);
    expect(scroller!.getInfo().newestId).toBe(100);
  });

  it('a newest init snapshot still establishes one persistent newer demand', async () => {
    let resolveInitFn: ((items: CbItem<number>[]) => void) | null = null;
    let newerCalls = 0;
    const item = (i: number): CbItem<number> =>
      i === 0
        ? { id: i, data: i, boundary: 'oldest' }
        : i === 99
          ? { id: i, data: i, boundary: 'newest' }
          : { id: i, data: i };
    const slice = (lo: number, hi: number): CbItem<number>[] => {
      const out: CbItem<number>[] = [];
      for (let i = Math.max(0, lo); i < Math.min(100, hi); i++)
        out.push(item(i));
      return out;
    };
    const src: CbSource<number> = {
      init: (anchorId) =>
        anchorId === -1
          ? new Promise((r) => {
              resolveInitFn = r;
            })
          : Promise.resolve([]),
      requestOlder: () => testDemand(async () => [], true),
      requestNewer: (c, k) =>
        testDemand(async () => {
          newerCalls++;
          return slice(c + 1, c + 1 + k);
        }),
      pushLive: () => {},
      getPending: () => [],
      destroy: () => {},
    };
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });

    const initP = scroller.init();
    await flush();
    // Signal for seq 99 — which the snapshot (80..99) already includes. Saved max-seq = 99.
    // No kernel signal is needed; the init snapshot already contains this high-water mark.
    const snapshot = slice(80, 100); // ids 80..99, 99 = newest → newestMounted = 99
    resolveInitFn!(snapshot);
    resolveInitFn = null;
    await initP;
    await flush();

    // The lower region always owns a cancellable newer waiter, including at the known newest edge.
    expect(newerCalls).toBe(1);
    expect(scroller!.getInfo().newestId).toBe(99);
  });

  it('scrolling to the top edge → loadOlder triggers getOlder, mounts older, oldestId moves older', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    const oldestBefore = scroller.getInfo().oldestId!;
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.gets()).toBeGreaterThan(0);
    // older mounted: oldestId index is smaller (older); after trim the window may scroll further, so oldestId can be even older
    expect(scroller.getInfo().oldestId!).toBeLessThanOrEqual(oldestBefore);
  });

  it('manually compensates scrollTop after an older prepend without jumping', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    viewport.scrollTop = 50;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    // loadOlder prepends above the viewport → scrollTop must be += the mounted height (> 50, not 0)
    expect(viewport.scrollTop).toBeGreaterThan(50);
  });

  it('after reaching the oldest boundary, further up-scroll → no more getOlder (noOlder breaker)', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(120); // only 120 items: init 100 + one fill batch reaches the oldest
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    for (let i = 0; i < 5; i++) {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(scroller.getInfo().noOlder).toBe(true);
    const getsAtBoundary = src.gets();
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.gets()).toBe(getsAtBoundary);
  });

  it('a source live update mounts at the bottom and follows', async () => {
    const { hooks } = controllableHooks();
    const src = pushedSource(fakeSource(500));
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    src.pushLive([{ id: 700, data: -1, boundary: 'newest' }]);
    await flush();
    const info = scroller.getInfo();
    expect(info.newestId).toBe(700);
    expect(info.atBottom).toBe(true);
  });

  // The reported "retry a pending send while a new message arrives → the new message renders UNDER the viewport".
  // Root cause: a live/newer item's real height settles AFTER pinToBottom already ran — the create-item height path
  // is a ResizeObserver that fires post-render (image/data/font settle), so the kernel measured a placeholder height
  // at mount, pinned to that (shorter) bottom, then the late growth extended the content below the fold with no
  // re-pin. Retry worsens the timing (its cb-move/cb-enter holds animating>0, deferring the no-op balance), but the
  // gap is the missing tail re-pin in onElHeight. Verifies the fix: a below-viewport item growing while pinned re-pins.
  it('onElHeight re-pins to bottom when a tail item grows after pin (async height settle — retry+new-message pin failure)', async () => {
    const source = liveSource(10);
    const { hooks, setHeight } = controllableHooks(100); // 100px real items
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source,
    });
    await scroller.init(); // m-0..m-9 (1000px), pinned at bottom (scrollTop = 400)

    // A live message arrives via the signal path. Pre-set a placeholder height (20) so measurePending reads 20 at
    // mount (models the pre-render measure before the RO reports the real height).
    setHeight(701, 20);
    source.pushLive([{ id: 701, data: 99 }]);
    await flush(); // the source demand mounts live-1 and pins to the updated bottom
    expect(scroller.getInfo().atBottom).toBe(true); // pinned at the placeholder bottom right after mount

    // The live item's real height settles asynchronously (RO fire) — AFTER pinToBottom ran.
    setHeight(701, 200); // grew by 180

    // Without the re-pin, the grown tail sinks below the fold (scrollTop stayed 420 while scrollHeight became 1200).
    // With the fix, onElHeight re-pins to the bottom for a below-viewport item growth while pinned.
    const info = scroller.getInfo();
    expect(info.atBottom).toBe(true);
    expect(viewport.scrollTop + 600).toBeGreaterThanOrEqual(
      content.scrollHeight - 1,
    );
  });

  // Net test for the OTHER onElHeight branch (above-fold growth → compensate, not pin). Currently untested: the
  // async-settle test above only covers the below-fold + pinned path. Mid-window positioning avoids arming an edge
  // load/trim so the compensate delta is observable in isolation.
  it('onElHeight: an above-fold item growing compensates scrollTop (+delta) so the visible content stays put', async () => {
    const { hooks, setHeight } = controllableHooks(100);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init(); // m-400..m-499 mounted, pinned at bottom (scrollTop 9400)
    scroller.scrollToIndex(450, 'center'); // mid-window, NOT at an edge (scrollTop ≈ 4750) → no edge load/trim
    const stBefore = viewport.scrollTop;
    setHeight(430, 150); // m-430 sits above the fold (topOf ≈ 3000 < scrollTop) → compensate +50
    expect(viewport.scrollTop).toBe(stBefore + 50); // the growth pushed content down; scrollTop followed to keep the fold put
  });

  it('trim: repeated loadOlder keeps the window stable, no unbounded growth (viewport buffer preserved)', async () => {
    const { hooks } = controllableHooks(); // 100px/item
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(5000),
    });
    await scroller.init();
    const totals: number[] = [];
    for (let i = 0; i < 10; i++) {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
      await Promise.resolve();
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
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    expect(content.querySelectorAll('.cb-pending').length).toBe(0);
  });

  // ── Phase 0: noOlder absorb timing (absorbed only after revalidate passes, preventing a fling-back from falsely locking) ──

  it('phase 0: a batch containing the oldest boundary is not mounted on reverse fling → noOlder not locked, getOlder still works back at top', async () => {
    const { hooks } = controllableHooks();
    const src = controllableSource(120); // init 100 → first getOlder returns m-0..m-19 (contains oldest m-0)
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
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
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    const oldest = scroller.getInfo().oldestId!;
    expect(
      content
        .querySelector(`[data-cb-id="${oldest}"]`)
        ?.classList.contains('cb-ghost'),
    ).toBe(true);
    expect(content.querySelectorAll('.cb-ghost').length).toBe(1);
  });

  it('phase 1: scrolling to the global oldest (noOlder) → cb-ghost disappears', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(120),
    });
    await scroller.init();
    for (let i = 0; i < 6; i++) {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(scroller.getInfo().noOlder).toBe(true);
    expect(content.querySelectorAll('.cb-ghost').length).toBe(0);
  });

  it('phase 1: loadOlder mounts an older neighbor → the old ghost rebuilds (createItem re-invoked with the new prev)', async () => {
    const { hooks, calls } = recordingHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    const ghostId = scroller.getInfo().oldestId!; // 400: mounted with prev=null (top)
    expect(calls.filter((c) => c.id === ghostId)[0].prev).toBeNull();

    // scroll up to trigger loadOlder (mount older m-300..m-399): ghostId gains an older neighbor → rebuild
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();

    const forGhost = calls.filter((c) => c.id === ghostId);
    expect(forGhost.length).toBe(2); // mount + rebuild
    expect(forGhost[1].prev).not.toBeNull(); // new prev = the older neighbor
  });

  it('phase 1: init fill-loop rebuilds each prior top ghost (no stuck spinner between batches)', async () => {
    // itemHeight 40 → 100-item init batch = 4000px < threshold 6000 → the init while-loop must run extra getOlder
    // fills. Each prepend must rebuild the previous top skeleton (spinner) into a real item, exactly as loadOlder does;
    // otherwise the spinner DOM stays mounted mid-list at the batch boundary (the "spinner between two batches" glitch).
    const { hooks } = skeletonHooks(40);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    // init filled past one batch (mounted > initBatch 100) → the loop ran at least once.
    expect(scroller.getInfo().mounted).toBeGreaterThan(100);
    expect(scroller.getInfo().noOlder).toBe(false); // the global oldest has NOT been reached → the top ghost is expected
    // Exactly ONE spinner element (the current top ghost). A second would mean a prior top was never rebuilt.
    expect(content.querySelectorAll('.cb-ghost-loading').length).toBe(1);
    // And that single spinner sits at the actual top of content (the first child = mounted[0]); none lurk mid-list.
    expect(
      content.firstElementChild?.classList.contains('cb-ghost-loading'),
    ).toBe(true);
  });

  it('init fill: an empty older page reveals the top skeleton as a real row', async () => {
    // A cache page may not carry an `oldest` boundary yet; the follow-up empty page is then the first
    // authoritative floor signal. Merely setting noOlder used to leave the skeleton component mounted.
    const source: CbSource<number> = {
      init: async () => [{ id: 7, data: 7, boundary: 'newest' }],
      requestOlder: () => testDemand(async () => [], true),
      requestNewer: () => testDemand(async () => []),
      pushLive: () => {},
      getPending: () => [],
      destroy: () => {},
    };
    const { hooks } = skeletonHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source,
    });

    await scroller.init();

    expect(scroller.getInfo().noOlder).toBe(true);
    expect(content.querySelectorAll('.cb-ghost-loading').length).toBe(0);
    expect(content.querySelectorAll('.real').length).toBe(1);
  });

  // Reproduces the production "shows some messages, then flashes to another batch on first init" glitch. Root cause: when
  // the init batch is sub-threshold (production's MAX_PAGE=50 caps a 100-item initBatch), the fill loop awaits getOlder —
  // a macrotask boundary, so the browser paints between the init mount and that resolve. The kernel MUST pin to the bottom
  // before yielding (and re-pin after each prepend), otherwise that inter-batch paint shows the init batch at scrollTop=0
  // (the OLDEST end of the newest batch, not the global newest) and only the final scrollToBottom lands correctly. Verified
  // by inspecting the in-flight state: with getOlder pending, the viewport is already at the bottom.
  it('init fill: pins to bottom BEFORE/DURING the multi-batch fill (no flash to the window top)', async () => {
    const { hooks } = controllableHooks(); // 100px items
    const src = controllableSource(500); // getOlder resolved manually
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
      config: { initBatch: 20 },
    });
    // initBatch 20 × 100px = 2000px < threshold 6000 → the fill loop MUST fire getOlder to top up.
    const p = scroller.init(); // do NOT await yet — inspect the in-flight state
    await flush(5); // run init up to the first loadOlderIntoFresh → await source.getOlder
    expect(src.isPending()).toBe(true); // a fill batch is in flight (confirms the fill loop fired)
    // While the fill batch is pending across a macrotask boundary, the viewport is already pinned at the bottom (shows the
    // global newest). Without the fix, scrollTop stayed 0 here → the first paint showed the window top → the flash.
    expect(scroller!.getInfo().atBottom).toBe(true);
    expect(scroller!.getInfo().newestId).toBe(499);
    src.resolveOlder(); // resolve the pending getOlder (prepend m-430..m-479)
    await p; // init re-pins after the prepend + final scrollToBottom
    expect(scroller!.getInfo().atBottom).toBe(true); // still viewing the global newest after the fill completes
    expect(scroller!.getInfo().newestId).toBe(499);
    expect(scroller!.getInfo().mounted).toBe(70); // 20 init + 50 fill
  });

  it('deferred init reveals the first page without getOlder, then backfills one anchored page', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
      config: { initBatch: 20, deferInitFill: true },
    });

    await scroller.init();

    expect(src.gets()).toBe(0);
    expect(scroller.getInfo().mounted).toBe(20);
    expect(scroller.getInfo().newestId).toBe(499);
    expect(scroller.getInfo().atBottom).toBe(true);

    await scroller.backfillOlder();

    expect(src.gets()).toBe(1);
    expect(scroller.getInfo().mounted).toBe(70);
    expect(scroller.getInfo().newestId).toBe(499);
    expect(scroller.getInfo().atBottom).toBe(true);
  });

  it('loadOlder trims the newest end → noNewer resets to false (loadNewer can load it back; fixes downward-scroll / pin-to-bottom stall)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    expect(scroller.getInfo().noNewer).toBe(true); // init pinned to bottom = global newest
    // scroll up → loadOlder: prepend older + trimNewer trims the newest end (incl. the global newest m-499)
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false); // the viewport left the lower region, so the newer demand was cancelled
  });

  it('destroy clears all mounted elements', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    expect(content.children.length).toBeGreaterThan(0);
    scroller.destroy();
    expect(content.children.length).toBe(0);
  });

  // ── Jump to a specific id (scrollToIndex / init({startMsgId})): mounted positioning + unmounted re-seed + centered fill / boundary compensation ──

  it('scrollToIndex mounted → positions by anchor (top/center/bottom)', async () => {
    const { hooks } = controllableHooks(); // 100px/item
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init(); // mounts m-400..m-499
    scroller.scrollToIndex(450, 'top'); // m-450 index=50 → prefix[50]=5000
    expect(viewport.scrollTop).toBe(5000);
    scroller.scrollToIndex(450, 'center'); // 5000 + 50 - 300
    expect(viewport.scrollTop).toBe(4750);
    scroller.scrollToIndex(450, 'bottom'); // 5000 + 100 - 600
    expect(viewport.scrollTop).toBe(4500);
  });

  it('init({startMsgId}) mid-history → bidirectional window around the target, centered, both sides ≥ threshold/2 (no fill)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(5000),
    });
    await scroller.init({ startMsgId: 2500, anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.oldestId).toBe(2451); // older 50 (m-2451..m-2500, includes the target)
    expect(info.newestId).toBe(2550); // newer 50 (m-2501..m-2550)
    expect(info.noOlder).toBe(false);
    expect(info.noNewer).toBe(false);
    expect(viewport.scrollTop).toBe(4650); // m-2500 index=49 centered: 4900+50-300
  });

  it('scrollToIndex not mounted → re-seeds the window around the id, target mounted and centered', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(5000),
    });
    await scroller.init(); // mounts m-4900..m-4999
    expect(scroller.getInfo().oldestId).toBe(4900);
    scroller.scrollToIndex(100, 'center'); // not mounted → async re-seed
    await flush();
    const info = scroller.getInfo();
    expect(info.oldestId).toBe(51);
    expect(info.newestId).toBe(150);
    expect(viewport.scrollTop).toBe(4650); // m-100 index=49 centered
  });

  // Regression: jumping to a NON-HEAD member of a merged album must still resolve to its album item.
  // Before the fix, openAround's hasTarget check (item.id === targetId) failed because the album item only
  // carries the head's id → early return → empty viewport. itemHasId now matches any member in CbItem.ids.
  it('scrollToIndex to a non-head album member msgId → resolves to album item, window non-empty (ids member-resolution regression)', async () => {
    const { hooks: baseHooks } = controllableHooks();
    // mergeItems: collapse m-10,m-11,m-12 into one album item (id=head m-10, ids=all three) — mirrors mergeAlbumItems.
    const mergeItems = (items: CbItem<number>[]): CbItem<number>[] => {
      const out: CbItem<number>[] = [];
      let i = 0;
      while (i < items.length) {
        const a = items[i],
          b = items[i + 1],
          c = items[i + 2];
        if (a.id === 10 && b && b.id === 11 && c && c.id === 12) {
          out.push({ ...a, ids: [10, 11, 12] });
          i += 3;
        } else {
          out.push(a);
          i++;
        }
      }
      return out;
    };
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks: {
        ...baseHooks,
        mergeItems,
        createItem: (item, prev) => {
          const view = baseHooks.createItem(item, prev);
          for (const id of item.ids ?? [item.id]) {
            const cell = document.createElement('div');
            cell.dataset['mediaMessageId'] = String(id);
            view.el.appendChild(cell);
          }
          return view;
        },
      },
      source: fakeSource(5000),
    });
    await scroller.init();
    scroller.scrollToIndex(11, 'center', true); // non-head album member → pre-fix: hasTarget=false → empty
    await flush();
    const info = scroller.getInfo();
    expect(info.mounted).toBeGreaterThan(0); // regression: was 0 (empty viewport) before fix
    expect(info.oldestId!).toBeLessThanOrEqual(10); // window brackets the album (m-10..m-12)
    expect(info.newestId!).toBeGreaterThanOrEqual(12);
    expect(viewport.scrollTop).toBe(750); // album (idx 10 · topOf 1000 · h 100) centered
    expect(
      content
        .querySelector('[data-cb-id="10"]')
        ?.classList.contains('cb-jump-highlight'),
    ).toBe(true);
    expect(
      content
        .querySelector('[data-media-message-id="11"]')
        ?.classList.contains('cb-jump-highlight-target'),
    ).toBe(true);
  });

  it('uses the last member id of a merged album as the newer cursor', async () => {
    let newerCursor: number | undefined;
    const source: CbSource<number> = {
      init: async () => [
        { id: 100, data: 1000 },
        { id: 101, data: 1001, boundary: 'newest' as const },
      ],
      requestOlder: () => testDemand(async () => [], true),
      requestNewer: (cursor) =>
        testDemand(async () => {
          newerCursor = cursor;
          return [];
        }),
      pushLive: () => {},
      getPending: () => [],
      destroy: () => {},
    };
    const mergeItems = (items: CbItem<number>[]): CbItem<number>[] =>
      items.length === 2 && items[0].id === 100 && items[1].id === 101
        ? [{ ...items[0], ids: [100, 101], boundary: 'newest' }]
        : items;
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks: { ...hooks, mergeItems },
      source,
    });
    await scroller.init();

    await flush();

    expect(newerCursor).toBe(101);
  });

  it('jump near oldest → noOlder, above < threshold/2 → downward compensation to threshold', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(5000),
    });
    await scroller.init({ startMsgId: 5, anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noOlder).toBe(true);
    expect(info.oldestId).toBe(0);
    expect(info.noNewer).toBe(false);
    expect(info.newestId).toBe(105); // seed newer 50 (m-6..m-55) + compensate 50 (m-56..m-105)
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000);
  });

  it('jump near newest → noNewer, below < threshold/2 → upward compensation to threshold', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(5000),
    });
    await scroller.init({ startMsgId: 4995, anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noNewer).toBe(true);
    expect(info.newestId).toBe(4999);
    expect(info.noOlder).toBe(false);
    expect(info.oldestId).toBe(4896); // upward compensation 50
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000);
  });

  it('tiny conversation jump → both sides at boundary, totalH < threshold, no compensation possible, render directly', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(30),
    });
    await scroller.init({ startMsgId: 15, anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noOlder).toBe(true);
    expect(info.noNewer).toBe(true);
    expect(info.oldestId).toBe(0);
    expect(info.newestId).toBe(29);
    expect(info.mounted).toBe(30);
    expect(sumChildrenHeight(content)).toBeLessThan(6000); // below threshold, both sides at boundary, cannot compensate
  });

  it('short-item jump → fill loop fills both sides to threshold/2 (no unbounded growth)', async () => {
    const { hooks } = controllableHooks(10); // 10px/item → seed 100 items only 1000px < 3000, needs fill
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(5000),
    });
    await scroller.init({ startMsgId: 2500, anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.mounted).toBeGreaterThan(100); // fill fired
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000); // filled to threshold
    expect(content.querySelector('[data-cb-id="2500"]')).toBeTruthy(); // target still in the window
  });

  it('scrollToIndex highlight → target row gets cb-jump-highlight', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    scroller.scrollToIndex(450, 'top', true);
    const el = content.querySelector<HTMLElement>('[data-cb-id="450"]');
    expect(el?.classList.contains('cb-jump-highlight')).toBe(true);
  });

  it('scrollToBottom highlight → newest row gets cb-jump-highlight', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    scroller.scrollToBottom(true);
    const newest = scroller.getInfo().newestId;
    const el = content.querySelector<HTMLElement>(`[data-cb-id="${newest}"]`);
    expect(el?.classList.contains('cb-jump-highlight')).toBe(true);
  });

  // ── Coverage: scrollToTop / refresh / loadNewer (downward load) / openAround boundary / gen overtake ──

  it('scrollToTop → scrollTop=0', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    expect(viewport.scrollTop).toBeGreaterThan(0); // init pinned to bottom
    scroller.scrollToTop();
    expect(viewport.scrollTop).toBe(0);
  });

  it('refresh → re-measures vh + balance, no throw, window still usable', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    expect(() => scroller!.refresh()).not.toThrow();
    // still positionable (kernel intact)
    scroller.scrollToIndex(scroller.getInfo().newestId!, 'top');
    expect(viewport.scrollTop).toBeGreaterThanOrEqual(0);
  });

  it('scrolling to the bottom edge → loadNewer triggers getNewer, mounts newer, newestId advances toward newest', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init(); // m-400..m-499 pinned to bottom, noNewer=true
    // scroll up: loadOlder → trimNewer trims the newest end → noNewer=false (loadNewer unlocked)
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    // scroll down to the bottom edge → loadNewer
    const newestBefore = scroller.getInfo().newestId!;
    viewport.scrollTop = content.scrollHeight - 600; // pinned to bottom
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.newers()).toBeGreaterThan(0); // getNewer called (loadNewer path)
    expect(scroller.getInfo().newestId!).toBeGreaterThan(newestBefore); // advances toward newest
  });

  it('remaining in the bottom load-more region continues demands until newest', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init(); // m-400..m-499 pinned to bottom, noNewer=true
    // scroll up: trimNewer trims the newest end → noNewer=false (loadNewer unlocked)
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    const newestBefore = scroller.getInfo().newestId!;
    // scroll down to the bottom edge (balance-triggered loadNewer, NOT scrollToBottom)
    viewport.scrollTop = content.scrollHeight - 600;
    viewport.dispatchEvent(new Event('scroll'));
    await waitFor(() => {
      const info = scroller!.getInfo();
      return info.noNewer && info.newestId === 499 && info.atBottom;
    }, 'the lower-region demand chain to reach newest');
    expect(src.newers()).toBeGreaterThan(1);
    expect(scroller.getInfo().newestId!).toBe(499);
    expect(scroller.getInfo().newestId!).toBeGreaterThan(newestBefore);
    expect(scroller.getInfo().noNewer).toBe(true);
    expect(viewport.scrollTop + 600).toBeGreaterThanOrEqual(
      content.scrollHeight - 1,
    );
  });

  it('scrollToBottom (go-to-bottom) chains through a trimmed newer end to the global newest (followToNewest)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
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
    expect(scroller.getInfo().newestId).toBe(499);
    expect(viewport.scrollTop + 600).toBeGreaterThanOrEqual(
      content.scrollHeight - 1,
    ); // pinned to the absolute bottom
  });

  // A live source update must NOT mount when the newer end is trimmed (!noNewer): mounting at the window tail would create a
  // cursor-order gap (live item before the unmounted m-251.. history) and let scrollToBottom→followToNewest chain to the
  // bottom. Cache only; items load in order when scrolling back down.
  it('a live update with a trimmed newer end caches only, no mount, no jump to bottom', async () => {
    const { hooks } = controllableHooks();
    const src = pushedSource(fakeSource(500));
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init(); // m-400..m-499 pinned to bottom, noNewer=true
    // scroll up: trim the newest end → noNewer=false (window is back in mid-history)
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    const mountedBefore = scroller.getInfo().mounted;
    const scrollTopBefore = viewport.scrollTop;
    // WS new message arrives (window in mid-history): cache only, no mount, no scrollToBottom
    src.pushLive([{ id: 702, data: 999, boundary: 'newest' }]);
    await flush();
    expect(scroller.getInfo().mounted).toBe(mountedBefore); // not mounted (prevents an order gap with m-251..)
    expect(viewport.scrollTop).toBe(scrollTopBefore); // no jump to bottom
  });

  it('openAround: a source batch missing the target preserves the current window and reports false', async () => {
    const { hooks } = controllableHooks();
    const src: CbSource<number> = {
      init: async () => [
        { id: 1, data: 1 },
        { id: 2, data: 2 },
      ], // missing the target
      requestOlder: () => testDemand(async () => [], true),
      requestNewer: () => testDemand(async () => []),
      pushLive: () => {},
      getPending: () => [],
      destroy: () => {},
    };
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    viewport.scrollTop = 37;
    const before = scroller.getInfo();
    await expectAsync(scroller.scrollToIndex(9999, 'center')).toBeResolvedTo(
      false,
    );
    expect(scroller.getInfo().oldestId).toBe(before.oldestId);
    expect(scroller.getInfo().newestId).toBe(before.newestId);
    expect(scroller.getInfo().mounted).toBe(before.mounted);
    expect(viewport.scrollTop).toBe(37);
  });

  it('init missing unread anchor with fallbackToLatest → mounts newest and reports the fallback', async () => {
    const { hooks } = controllableHooks();
    const fallback = jasmine.createSpy('fallback');
    const src = fakeSource(20);
    await src.init(9999, 1, 1); // document the missing target in this source
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });

    await scroller.init({
      startMsgId: 9999,
      anchor: 'top',
      fallbackToLatest: true,
      onFallbackToLatest: fallback,
    });

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(scroller.getInfo().newestId).toBe(19);
    expect(scroller.getInfo().mounted).toBeGreaterThan(0);
  });

  it('two jumps in a row → gen guard: the in-flight first jump is dropped, the final window surrounds the second', async () => {
    const { hooks } = controllableHooks();
    const src = controllableInitSource(5000);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    scroller.scrollToIndex(100, 'center'); // openAround #1: init pending (gen=1)
    scroller.scrollToIndex(200, 'center'); // openAround #2: ++gen=2, reset, init pending
    expect(src.initPending()).toBe(2);
    src.resolveInit(src.batchAround(100)); // #1 resolve → gen(1)≠2 → dropped
    src.resolveInit(src.batchAround(200)); // #2 resolve → mounts m-151..m-250
    await flush();
    const info = scroller.getInfo();
    expect(info.oldestId).toBe(151); // surrounds m-200, not m-100
    expect(info.newestId).toBe(250);
  });

  // ── insertAfter: mid-window insert with no balance + manual scrollTop compensation ──

  it('insertAfter on a non-mounted id → no-op (returns false, no mount, no load)', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    const mountedBefore = scroller.getInfo().mounted;
    const ok = scroller.insertAfter(9999, { id: -1, data: -1 });
    expect(ok).toBe(false);
    expect(scroller.getInfo().mounted).toBe(mountedBefore);
    expect(content.querySelector('[data-cb-id="-1"]')).toBeNull();
    expect(src.gets()).toBe(0); // no balance → no loadOlder
    expect(src.newers()).toBe(1); // the persistent lower-region waiter is unrelated to insertAfter
  });

  it('insertAfter mid-window → mounts at idx+1 in the right DOM position (between target and successor)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init(); // m-400..m-499
    const mountedBefore = scroller.getInfo().mounted;
    const ok = scroller.insertAfter(450, { id: -1, data: -1 });
    expect(ok).toBe(true);
    expect(scroller.getInfo().mounted).toBe(mountedBefore + 1);
    const ids = Array.from(content.children).map(
      (c) => (c as HTMLElement).dataset['cbId'],
    );
    const i = ids.indexOf('450');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(ids[i + 1]).toBe('-1'); // inserted right after the target
    expect(ids[i + 2]).toBe('451'); // successor still after the new item
  });

  it('insertAfter rebuilds the successor with the new prev; the new item is created once with the target as prev', async () => {
    const { hooks, calls } = recordingHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init(); // mounts m-400..m-499 once each
    scroller.insertAfter(450, { id: -1, data: -1 });
    const ins = calls.filter((c) => c.id === -1);
    expect(ins.length).toBe(1);
    expect(ins[0].prev).toBe(450); // new item's prev = target
    const succ = calls.filter((c) => c.id === 451);
    expect(succ.length).toBe(2); // init mount + rebuild
    expect(succ[1].prev).toBe(-1); // rebuilt with prev = the new item
  });

  it('manually compensates an insert above the viewport without triggering balance', async () => {
    const { hooks } = controllableHooks(); // 100px/item
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init(); // pinned to bottom (scrollTop 9400); m-400 (top 0) is above the viewport
    const stBefore = viewport.scrollTop;
    const ok = scroller.insertAfter(400, { id: -1, data: -1 }); // ins at idx 1, top 100 < 9400 → compensate
    expect(ok).toBe(true);
    expect(viewport.scrollTop).toBe(stBefore + 100); // += newH (successor m-401 rebuild delta is 0)
    expect(src.gets()).toBe(0); // no balance → no loadOlder/loadNewer
    expect(src.newers()).toBe(1); // existing lower-region waiter is independent from the insert
  });

  it('leaves scrollTop unchanged for an insert below the viewport', async () => {
    const { hooks } = controllableHooks(); // 100px/item
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init(); // m-400..m-499
    scroller.scrollToIndex(450, 'top'); // scrollTop = topOf(m-450) = 5000; viewport [5000,5600]
    expect(viewport.scrollTop).toBe(5000);
    scroller.insertAfter(480, { id: -1, data: -1 }); // ins top 8100, below the viewport
    expect(viewport.scrollTop).toBe(5000); // no compensation (insert is below the fold)
  });

  // Regression: a transient inserted at the tail must NOT become the getNewer cursor. Without the cursor guard,
  // loadNewer would call getNewer('ins') → the source can't find it → [] → noNewer falsely locked → newer history
  // never loads. newerCursorId skips transient entries, so the real tail id is used instead.
  it('cursor guard: a transient at the tail does not poison loadNewer', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init(); // m-400..m-499, noNewer=true
    // scroll up: loadOlder prepends older + trimNewer trims the newest end → noNewer=false (mid-history)
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    const tailId = scroller.getInfo().newestId!; // last real mounted item before insert
    // insert AFTER the last mounted item → the transient becomes the new tail
    const ok = scroller.insertAfter(tailId, { id: -1, data: -1 });
    expect(ok).toBe(true);
    expect(scroller.getInfo().newestId).toBe(-1); // transient is now the tail
    // drain the cb-enter so the checkpoint is not deferred when scrolling to the bottom edge
    content
      .querySelector<HTMLElement>('[data-cb-id="-1"]')
      ?.dispatchEvent(new Event('animationend'));
    // scroll down to the bottom edge → demand triggers loadNewer; cursor must skip the transient
    viewport.scrollTop = content.scrollHeight - 600;
    viewport.dispatchEvent(new Event('scroll'));
    await waitFor(
      () => src.newers() > 0 && scroller!.getInfo().noNewer,
      'the transient-safe newer demand to reach its boundary',
    );
    expect(src.newers()).toBeGreaterThan(0); // getNewer was called with the real cursor (skipped 'ins')
    expect(scroller.getInfo().newestId).toBe(-1); // transient stays at the tail (reals insert before the tail block)
    // Remaining in the lower load-more region keeps requesting until the real newest boundary. Reaching that
    // boundary is expected; cursor poisoning is ruled out by the source call and mounted successor assertions.
    expect(scroller.getInfo().noNewer).toBe(true);
    // A newer real remains immediately above the transient tail. The exact first successor may have been trimmed once
    // the persistent demand reached newest, so assert ordering instead of pinning the test to one retained window item.
    const transient = content.querySelector<HTMLElement>('[data-cb-id="-1"]')!;
    const precedingRealId = Number(
      transient.previousElementSibling?.getAttribute('data-cb-id'),
    );
    expect(precedingRealId).toBeGreaterThan(tailId);
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
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    expect(content.querySelectorAll('.cb-enter').length).toBe(0);
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(content.querySelectorAll('.cb-enter').length).toBe(0); // scroll-loaded history does not animate either
  });

  it('Phase A: insertAfter plays cb-enter on the new row; animationend removes it', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    scroller.insertAfter(450, { id: -1, data: -1 });
    const el = content.querySelector<HTMLElement>('[data-cb-id="-1"]');
    expect(el?.classList.contains('cb-enter')).toBe(true);
    animEnd('-1');
    expect(el?.classList.contains('cb-enter')).toBe(false);
  });

  it('Phase A: a source live update plays cb-enter on the live row', async () => {
    const { hooks } = controllableHooks();
    const src = pushedSource(fakeSource(500));
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    src.pushLive([{ id: 700, data: -1, boundary: 'newest' }]);
    await flush();
    expect(
      content
        .querySelector<HTMLElement>('[data-cb-id="700"]')
        ?.classList.contains('cb-enter'),
    ).toBe(true);
  });

  it('Phase A: source demand remains active while cb-enter balance work is deferred', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    const getsBefore = src.gets();
    scroller.insertAfter(400, { id: -1, data: -1 }); // cb-enter, animating=1
    viewport.scrollTop = 0; // top edge → loadOlder would fire if balance ran
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.gets()).toBeGreaterThan(getsBefore); // subscription is independent from the animation gate
    animEnd('-1');
    await flush();
    expect(src.gets()).toBeGreaterThan(getsBefore);
  });

  // The user's called-out bug: many transient fakes at the tail must not be eaten by trimNewer when loadOlder fires at
  // the top (transients are not in the source → trimming would permanently lose them).
  it('Phase A: trimNewer skips a transient at the tail (in-flight optimistic survives loadOlder)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init(); // m-400..m-499
    scroller.insertAfter(499, { id: -1, data: -1 }); // transient at the tail
    animEnd('-1'); // drain cb-enter so balance can run
    await flush();
    viewport.scrollTop = 0; // scroll to top → loadOlder + trimNewer
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().newestId).toBe(-1); // transient survived the trim
    expect(content.querySelector('[data-cb-id="-1"]')).not.toBeNull();
  });

  // A source update behind the active cursor is not delivered by the newer waiter.
  it('Phase B: a stale live item does not duplicate a mounted optimistic', async () => {
    const { hooks } = controllableHooks();
    const src = pushedSource(fakeSource(500));
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    const mountedBefore = scroller.getInfo().mounted;
    scroller.insertAfter(499, { id: -1, data: -1 }, { optimistic: true }); // optimistic at tail
    expect(scroller.getInfo().mounted).toBe(mountedBefore + 1);
    animEnd('-1'); // drain its enter animation
    src.pushLive([{ id: -1, data: 777 }]);
    await flush();
    expect(scroller.getInfo().mounted).toBe(mountedBefore + 1); // no duplicate
    expect(content.querySelector('[data-cb-id="-1"]')).not.toBeNull();
  });

  // Optimistic→confirmed via source demand: the newer demand pulls the real confirm, mounts it visibly at
  // its true position, then reconcileOptimistic synchronously removes the optimistic duplicate and tags the real
  // cb-confirmed. Height model and mount count stay exact (one entry for the id throughout).
  it('a newer source demand reconciles an optimistic send into its confirmed real', async () => {
    const { hooks } = controllableHooks();
    // getNewer returns the real confirm: a FRESH server id + the SAME clientMessageId as the optimistic (the reconcile
    // key — the kernel pairs them by clientMessageId, not id, since the real's id is brand-new). boundary newest so
    // noNewer is re-absorbed true.
    const base = fakeSource(500);
    const src = pushedSource(base);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init(); // m-400..m-499 mounted, noNewer=true
    const mountedBefore = scroller.getInfo().mounted;
    scroller.insertAfter(
      499,
      { id: -1, data: -1, clientMessageId: 'cid-0' },
      { optimistic: true },
    ); // optimistic bubble at the tail (tracked by cid-0)
    animEnd('-1'); // drain its cb-enter
    expect(scroller.getInfo().mounted).toBe(mountedBefore + 1);
    src.pushLive([
      {
        id: 600,
        data: 777,
        clientMessageId: 'cid-0',
        boundary: 'newest',
      },
    ]);
    await flush();
    // optimistic (pending-0) removed, real (real-0) revealed → the confirmed real remains at the tail — not trimmed.
    expect(content.querySelectorAll('[data-cb-id="-1"]').length).toBe(0);
    expect(content.querySelectorAll('[data-cb-id="600"]').length).toBe(1);
    expect(
      content
        .querySelector('[data-cb-id="600"]')
        ?.classList.contains('cb-confirmed'),
    ).toBe(true); // real tagged cb-confirmed
  });

  // Regression (first-send scrollTop bug): after a newer demand reconciles the optimistic into its real, the confirmed
  // real MUST be pinned to the bottom (scrollTop = scrollHeight − vh). The bug: pinToBottom-after-reconcile left the real
  // below the fold on the FIRST send, subsequent sends correct. This pins both the first and a subsequent send.
  it('a newer source demand pins the confirmed real to the bottom for first and subsequent sends', async () => {
    const { hooks } = controllableHooks();
    const base = fakeSource(500);
    const src = pushedSource(base);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init(); // m-400..m-499, noNewer=true

    // --- Send #1 ---
    scroller.insertAfter(
      499,
      { id: -1, data: -1, clientMessageId: 'cid-0' },
      { optimistic: true },
    );
    animEnd('-1');
    scroller.scrollToBottom();
    src.pushLive([
      { id: 600, data: 777, clientMessageId: 'cid-0', boundary: 'newest' },
    ]);
    await flush();
    const i1 = scroller.getInfo();
    expect(content.querySelectorAll('[data-cb-id="600"]').length).toBe(1);
    expect(i1.atBottom).toBe(true);
    expect(i1.scrollTop).toBe(i1.scrollHeight - i1.viewportHeight); // real pinned to the bottom, not below the fold

    // --- Send #2 (the previously-correct case — must stay correct) ---
    scroller.insertAfter(
      600,
      { id: -1, data: -1, clientMessageId: 'cid-1' },
      { optimistic: true },
    );
    animEnd('-1');
    scroller.scrollToBottom();
    src.pushLive([
      { id: 601, data: 777, clientMessageId: 'cid-1', boundary: 'newest' },
    ]);
    await flush();
    const i2 = scroller.getInfo();
    expect(content.querySelectorAll('[data-cb-id="601"]').length).toBe(1);
    expect(i2.atBottom).toBe(true);
    expect(i2.scrollTop).toBe(i2.scrollHeight - i2.viewportHeight);
  });

  // Regression (overlap race, the user-reported "opponent msg inserts between pending / a msg sinks under viewport"):
  // two signals landing in the same microtask window (two onSignal callbacks back-to-back).
  // The bug: the source-demand path had no single-flight guard, so the second pull bailed on the active demand (the
  // in-flight first call owned it) → the second live item never mounted until the NEXT signal (orphaned), AND both calls'
  // flipMove overlapped on the surviving optimistic tail (moveTimer overwritten → animating leaked; the shove double-played
  // and a deferred balance never drained). Source flavor under test: a caching source whose getNewer SPLICES the live
  // cache synchronously (the playground mock's model) — the kernel must coalesce regardless of how the source holds data.
  it('overlapping source notifications coalesce and drain both items without leaking animation state', async () => {
    const { hooks } = controllableHooks(40);
    const src = pushedSource(fakeSource(500));
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init(); // m-400..m-499, noNewer=true
    scroller.scrollToBottom();
    // user's in-flight optimistic send at the tail → incoming opponent msgs shove a SURVIVING tail (the flipMove path)
    scroller.insertAfter(
      499,
      { id: -1, data: -1, clientMessageId: 'cid-0' },
      { optimistic: true },
    );
    animEnd('-1');
    scroller.scrollToBottom();

    // Two SSE frames land in the same microtask window: op-1 is cached AFTER the first newer demand
    // sync-drained [op-0] but BEFORE its loadNewer resolves — exactly the one-microtask race window.
    src.pushLive([{ id: 800, data: 100 }]); // partial frame: waiter remains pending
    src.pushLive([{ id: 801, data: 101, boundary: 'newest' as const }]); // boundary makes the accumulated demand satisfiable
    await flush();

    // Both opponent messages must be mounted (without the fix, op-1 is orphaned in the live cache until the next signal).
    expect(content.querySelectorAll('[data-cb-id="800"]').length).toBe(1);
    expect(content.querySelectorAll('[data-cb-id="801"]').length).toBe(1);
    // The viewport stayed pinned to the FINAL bottom across the burst (no message sinks below the fold).
    const info = scroller.getInfo();
    expect(info.atBottom).toBe(true);
    expect(info.scrollTop).toBe(info.scrollHeight - info.viewportHeight);
    // The overlap must not leak the animating counter (the double flipMove on the surviving tail): drain EVERY in-flight
    // animation (cb-enter-above on op-0/op-1, cb-move shove on pending-0) and confirm the counter returns to 0. A leak
    // sticks it > 0 forever, deferring every later scheduleBalance → edge-loading silently stops working.
    for (const sel of [
      '.cb-enter',
      '.cb-enter-above',
      '.cb-move',
      '.cb-leave',
    ]) {
      for (const el of Array.from(content.querySelectorAll<HTMLElement>(sel)))
        el.dispatchEvent(new Event('animationend'));
    }
    expect((scroller as unknown as { animating: number }).animating).toBe(0);
  });

  // Symmetric optimistic lifecycle: a push that extends the newest (a non-newest page lands while pinned at the newest)
  // UNMOUNTS the in-flight optimistic tail (they're recoverable via getPending); reaching the newest again RE-MOUNTS them.
  it('a partial newer demand restores optimistic items only after reaching newest', async () => {
    const { hooks } = controllableHooks();
    // Backlog source: getNewer drains a queue (page 1 = 50 reals WITHOUT 'newest', page 2 = reals WITH 'newest');
    // getPending returns the in-flight optimistic sends the kernel (re)mounts at the newest edge.
    const pending: CbItem<number>[] = [];
    const batches: CbItem<number>[][] = [
      Array.from({ length: 50 }, (_, i) => ({ id: 600 + i, data: i })),
      Array.from({ length: 10 }, (_, i) => ({
        id: 650 + i,
        data: 50 + i,
        boundary: 'newest' as const,
      })),
    ];
    const src = pushedSource({
      ...fakeSource(500),
      getPending: () => pending.slice(),
    });
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init(); // m-400..m-499, noNewer=true
    const optA: CbItem<number> = { id: -1, clientMessageId: 'cid-a', data: -1 };
    const optB: CbItem<number> = { id: -2, clientMessageId: 'cid-b', data: -1 };
    pending.push(optA, optB); // playground addPending (the backing store)
    scroller.insertAfter(499, optA, { optimistic: true }); // mount for immediate display
    scroller.insertAfter(-1, optB, { optimistic: true });
    animEnd('-1');
    animEnd('-2');
    expect(content.querySelectorAll('[data-cb-id="-1"]').length).toBe(1);
    expect(content.querySelectorAll('[data-cb-id="-2"]').length).toBe(1);

    // Push #1: a 50-real page WITHOUT 'newest' (large backlog). wasAtNewest=true → noNewer=false → optimistic unmounted.
    src.pushLive(batches.shift()!);
    await flush();
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    expect(content.querySelectorAll('[data-cb-id="-1"]').length).toBe(0); // unmounted (recoverable via getPending)
    expect(content.querySelectorAll('[data-cb-id="-2"]').length).toBe(0);
    expect(content.querySelectorAll('[data-cb-id="649"]').length).toBe(1); // the 50 backlog reals did mount

    // Scroll back to the newest → followToNewest loads page 2 (newest) → elevatePending re-mounts the in-flight sends.
    src.pushLive(batches.shift()!);
    scroller.scrollToBottom();
    await flush();
    expect(scroller.getInfo().noNewer).toBe(true);
    expect(content.querySelectorAll('[data-cb-id="-1"]').length).toBe(1); // re-mounted via getPending
    expect(content.querySelectorAll('[data-cb-id="-2"]').length).toBe(1);
    expect(scroller.getInfo().newestId).toBe(-2); // optimistic block is the tail again
  });

  // Regression: a SMALL push (the page reaches the global newest) does NOT unmount optimistic — noNewer stays true,
  // elevatePending skips already-mounted sends. Only a non-newest push (the backlog case above) unmounts them.
  it('a newest-reaching demand keeps optimistic items mounted', async () => {
    const { hooks } = controllableHooks();
    const pending: CbItem<number>[] = [];
    const base = fakeSource(500);
    const src: CbSource<number> = {
      ...base,
      requestNewer: () =>
        testDemand(async () => [
          { id: 600, data: 0, boundary: 'newest' as const },
        ]),
      pushLive: () => {},
      getPending: () => pending.slice(),
    };
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init(); // noNewer=true
    const optA: CbItem<number> = { id: -1, clientMessageId: 'cid-a', data: -1 };
    pending.push(optA);
    scroller.insertAfter(499, optA, { optimistic: true });
    animEnd('-1');
    await flush();
    await flush();
    expect(scroller.getInfo().noNewer).toBe(true);
    expect(content.querySelectorAll('[data-cb-id="-1"]').length).toBe(1); // survived (elevate skipped it — already mounted)
    expect(content.querySelectorAll('[data-cb-id="600"]').length).toBe(1);
  });

  // A confirm (real matching an in-flight optimistic by clientMessageId) takes the optimistic's slot — same id, same
  // position — so it does NOT play a cb-enter: the bubble is already on screen as the optimistic; only the cb-confirmed
  // spinner→check choreography plays (reconcileOptimistic tags it). The optimistic duplicate is removed synchronously
  // (no two-bubble flash). (A PLAIN incoming real — no clientMessageId — still enters from above; see the next test.)
  it('a confirmed real from a newer demand settles without an enter animation', async () => {
    const { hooks } = controllableHooks();
    const base = fakeSource(500);
    const src = pushedSource(base);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    scroller.insertAfter(
      499,
      { id: -1, data: -1, clientMessageId: 'cid-0' },
      { optimistic: true },
    ); // tail bubble tracked by cid-0
    animEnd('-1'); // drain the optimistic's own cb-enter
    src.pushLive([
      {
        id: 600,
        data: 777,
        clientMessageId: 'cid-0',
        boundary: 'newest',
      },
    ]);
    await flush();
    const real = content.querySelector<HTMLElement>('[data-cb-id="600"]');
    expect(real).not.toBeNull();
    expect(real?.classList.contains('cb-enter-above')).toBe(false); // confirm replaces the optimistic in place → no enter
    expect(real?.classList.contains('cb-enter')).toBe(false); // no from-below enter either
    expect(real?.classList.contains('cb-confirmed')).toBe(true); // only the spinner→check choreography plays
    expect(content.querySelector('[data-cb-id="-1"]')).toBeNull(); // optimistic duplicate removed (no two-bubble flash)
  });

  // confirmPending is the decoupled delivery-confirm path: fired at the HTTP-200 / upload-success milestone, it morphs
  // the OPTIMISTIC bubble to the source's fresh status:'sent' snapshot IN PLACE (update, no remount) and tags it
  // cb-confirmed so the spinner→check→fade choreography plays WITHOUT a mount/unmount or a cb-move FLIP — the later
  // SSE-echo reconcile still owns those. Single-trigger: no-op when the optimistic is gone (SSE won the race) or the
  // entry is already confirmed.
  it('confirmPending: morphs the optimistic in place (update, no remount) + tags cb-confirmed, no FLIP', async () => {
    const t = trackingHooks();
    const base = fakeSource(500);
    const sent: CbItem<number> = {
      id: -1,
      clientMessageId: 'cid-cp',
      data: 999,
    }; // fresh status:'sent' snapshot (new data ref)
    const src: CbSource<number> = { ...base, getPending: () => [sent] };
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks: t.hooks,
      source: src,
    });
    await scroller.init();
    scroller.insertAfter(
      499,
      { id: -1, data: -1, clientMessageId: 'cid-cp' },
      { optimistic: true },
    );
    animEnd('-1');
    await flush();

    const elBefore = content.querySelector('[data-cb-id="-1"]');
    expect(elBefore?.classList.contains('cb-confirmed')).toBe(false);
    const createsBefore = t.createCount();
    const updatesBefore = t.updateCount();

    scroller.confirmPending('cid-cp');
    await flush();

    expect(content.querySelector('[data-cb-id="-1"]')).toBe(elBefore); // SAME element — in place, no remount
    expect(elBefore?.classList.contains('cb-confirmed')).toBe(true); // spinner→check→fade choreography gated
    expect(t.createCount()).toBe(createsBefore); // NO recreate (in-place morph only)
    expect(t.updateCount()).toBe(updatesBefore + 1); // fresh snapshot applied via update
    expect(t.dataOf(-1)).toBe(999); // the fresh "sent" data
    expect(content.querySelectorAll('[data-cb-id="-1"]').length).toBe(1); // no duplicate bubble
    expect(elBefore?.classList.contains('cb-move')).toBe(false); // decoupled — NO reorder FLIP
  });

  it('confirmPending: no-op when no optimistic matches the cid (the SSE echo already swapped it out)', async () => {
    const t = trackingHooks();
    const base = fakeSource(500);
    const src: CbSource<number> = { ...base, getPending: () => [] };
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks: t.hooks,
      source: src,
    });
    await scroller.init();
    const updatesBefore = t.updateCount();
    scroller.confirmPending('cid-absent'); // nothing mounted for this cid
    await flush();
    expect(t.updateCount()).toBe(updatesBefore); // no morph
    expect(content.querySelector('[data-cb-id="-1"]')).toBeNull();
  });

  it('confirmPending: play once — a second call on an already-confirmed entry does NOT re-morph', async () => {
    const t = trackingHooks();
    const base = fakeSource(500);
    let sent: CbItem<number> = {
      id: -1,
      clientMessageId: 'cid-once',
      data: 111,
    };
    const src: CbSource<number> = { ...base, getPending: () => [sent] };
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks: t.hooks,
      source: src,
    });
    await scroller.init();
    scroller.insertAfter(
      499,
      { id: -1, data: -1, clientMessageId: 'cid-once' },
      { optimistic: true },
    );
    animEnd('-1');
    await flush();

    scroller.confirmPending('cid-once');
    await flush();
    expect(t.dataOf(-1)).toBe(111);
    const updatesAfterFirst = t.updateCount();

    sent = { id: -1, clientMessageId: 'cid-once', data: 222 }; // a different fresh snapshot
    scroller.confirmPending('cid-once'); // cb-confirmed already present → guard returns
    await flush();
    expect(t.updateCount()).toBe(updatesAfterFirst); // no second morph — the lock held
    expect(t.dataOf(-1)).toBe(111); // still the FIRST snapshot, not 222
  });

  // Defensive prune at send-success: if the real that fulfills the optimistic (same clientMessageId) is ALREADY mounted
  // — the mount loaded past the pending's seq while the optimistic never entered its removal flow — confirmPending must
  // self-heal by removing the stale optimistic (the real owns the slot) and surface a warn, NOT morph a duplicate bubble.
  // By construction this state is unreachable via markSent (the SSE-echo path drops source.pending first → markPendingSent
  // returns false → confirmPending is never called), so these tests manufacture the orphan directly to cover the backstop.
  it('confirmPending: defensively removes a stale optimistic whose fulfilling real is already mounted (+warn, no morph)', async () => {
    const warnSpy = spyOn(console, 'warn');
    const t = trackingHooks();
    const cid = 'cid-stale';
    // A source whose newest real (id 499) carries the SAME cid as the in-flight optimistic — the orphan. getPending
    // returns [] to mirror that source.pending was already dropped (only the mounted optimistic lingered).
    const src: CbSource<number> = {
      ...fakeSource(500),
      init: async () => {
        const out: CbItem<number>[] = [];
        for (let i = 400; i <= 499; i++)
          out.push(
            i === 499
              ? { id: i, data: i, clientMessageId: cid, boundary: 'newest' }
              : { id: i, data: i },
          );
        return out;
      },
      getPending: () => [],
    };
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks: t.hooks,
      source: src,
    });
    await scroller.init();
    // Mount the stale optimistic AFTER the real. insertAfter does not reconcile, so both now coexist (the orphan).
    scroller.insertAfter(
      499,
      { id: -1, data: -1, clientMessageId: cid },
      { optimistic: true },
    );
    animEnd('-1');
    await flush();
    expect(content.querySelectorAll('[data-cb-id="-1"]').length).toBe(1); // orphan present before the fix
    expect(content.querySelectorAll('[data-cb-id="499"]').length).toBe(1);

    const updatesBefore = t.updateCount();
    scroller.confirmPending(cid); // send-success milestone fires on the stale optimistic
    await flush();

    expect(content.querySelectorAll('[data-cb-id="-1"]').length).toBe(0); // stale optimistic removed (self-heal)
    expect(content.querySelectorAll('[data-cb-id="499"]').length).toBe(1); // fulfilling real untouched — owns the slot
    expect(t.updateCount()).toBe(updatesBefore); // NO in-place morph (returned before the update path)
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.calls.mostRecent().args[0])).toContain(
      'stale optimistic',
    ); // invariant violation is observable
  });

  it('confirmPending: defensive removal is album-aware (a real whose clientMessageIds album includes the cid)', async () => {
    const warnSpy = spyOn(console, 'warn');
    const t = trackingHooks();
    const cid = 'cid-album-member';
    // The fulfilling real is an album head whose clientMessageIds includes the optimistic's cid (e.g. a self-sent image
    // absorbed into a running album). itemFulfilledCids must surface it so the defensive prune fires album-aware.
    const src: CbSource<number> = {
      ...fakeSource(500),
      init: async () => {
        const out: CbItem<number>[] = [];
        for (let i = 400; i <= 499; i++)
          out.push(
            i === 499
              ? {
                  id: i,
                  data: i,
                  clientMessageIds: ['cid-other', cid],
                  boundary: 'newest',
                }
              : { id: i, data: i },
          );
        return out;
      },
      getPending: () => [],
    };
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks: t.hooks,
      source: src,
    });
    await scroller.init();
    scroller.insertAfter(
      499,
      { id: -1, data: -1, clientMessageId: cid },
      { optimistic: true },
    );
    animEnd('-1');
    await flush();

    scroller.confirmPending(cid);
    await flush();

    expect(content.querySelectorAll('[data-cb-id="-1"]').length).toBe(0); // stale optimistic removed via the album cid
    expect(content.querySelectorAll('[data-cb-id="499"]').length).toBe(1); // album real untouched
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  // A plain incoming real (no clientMessageId) landing ABOVE an optimistic tail does NOT confirm anything, so the tail
  // survives and is shoved DOWN by the real's height. That shove is non-zero → the surviving tail gets a cb-move FLIP, and
  // the incoming real enters from above (cb-enter-above) for the same cover-avoidance reason. This exercises the tail-shove
  // branch of the coordinated animation (the confirm case above has a zero shove since real and optimistic share content).
  it('a plain incoming real from a newer demand moves the optimistic tail and enters from above', async () => {
    const { hooks } = controllableHooks(100);
    const src = pushedSource(fakeSource(500));
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    scroller.insertAfter(
      499,
      { id: -1, data: -1, clientMessageId: 'cid-0' },
      { optimistic: true },
    ); // tail bubble NOT confirmed by real-X
    animEnd('-1');
    src.pushLive([{ id: 602, data: 777, boundary: 'newest' as const }]);
    await flush();
    // The incoming real entered from above (tail present → cover avoidance), NOT from below.
    expect(
      content
        .querySelector('[data-cb-id="602"]')
        ?.classList.contains('cb-enter-above'),
    ).toBe(true);
    expect(
      content
        .querySelector('[data-cb-id="602"]')
        ?.classList.contains('cb-enter'),
    ).toBe(false);
    // The surviving tail was shoved DOWN by the real's height → non-zero delta → cb-move FLIP in flight.
    expect(
      content.querySelector('[data-cb-id="-1"]')?.classList.contains('cb-move'),
    ).toBe(true);
    expect(content.querySelector('[data-cb-id="-1"]')).not.toBeNull(); // still mounted (real-X did not confirm it)
  });

  // Fake absorbTail for the number-based kernel spec: data >= 1000 marks an "image"; two images merge by summing (the
  // sum stays >= 1000, so a run of images keeps folding into the same target). data < 1000 is a "non-image" that breaks
  // the run. Mirrors absorbAlbumTail's policy (same sender + both images) without the chat-domain types.
  function numAbsorb(
    target: CbItem<number>,
    incoming: CbItem<number>,
  ): CbItem<number> | null {
    if (target.data < 1000 || incoming.data < 1000) return null;
    return { ...target, data: target.data + incoming.data };
  }

  // Cross-batch image-burst absorb (the core feature): per-batch mergeItems cannot coalesce images that arrive in
  // SEPARATE batches/signals. absorbTail folds a same-"sender" image arriving in a later batch into the running newest
  // image entry — morphed in place (update, not create → no new bubble). fakeSource init data is the index (0..499), all
  // < 1000, so the pre-existing newest is NOT an image and the first image mounts normally before becoming the absorb target.
  it('absorbTail: a same-sender image burst across SEPARATE batches absorbs into one entry (cross-batch coalesce)', async () => {
    const t = trackingHooks();
    const hooks = { ...t.hooks, absorbTail: numAbsorb };
    const batches: CbItem<number>[][] = [
      [{ id: 700, data: 1001, boundary: 'newest' as const }],
      [{ id: 701, data: 1002, boundary: 'newest' as const }],
    ];
    const src = pushedSource(fakeSource(500));
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    const createsAfterInit = t.createCount();

    src.pushLive(batches.shift()!);
    await flush(); // img1 mounts (newest wasn't an image → no absorb)
    expect(t.createCount()).toBe(createsAfterInit + 1);
    animEnd('700');

    src.pushLive(batches.shift()!);
    await flush(); // img2 → newest IS img1 → ABSORB
    expect(t.createCount()).toBe(createsAfterInit + 1); // no new mount
    expect(t.updateCount()).toBe(1); // img1 morphed in place
    expect(t.dataOf(700)).toBe(1001 + 1002); // merged data
    expect(content.querySelectorAll('[data-cb-id="701"]').length).toBe(0); // no separate img2 entry
  });

  // Mixed batch [img, img, text, img]: the leading image run absorbs into the first image; the text breaks the run and
  // mounts normally; the trailing image mounts FRESH (it must not leap back across the text into the first album).
  it('absorbTail: a mixed batch [img, img, text, img] absorbs the leading run, then mounts the rest (no leapfrog)', async () => {
    const t = trackingHooks();
    const hooks = { ...t.hooks, absorbTail: numAbsorb };
    const batch: CbItem<number>[] = [
      { id: 700, data: 1001 },
      { id: 701, data: 1002 },
      { id: 702, data: 5 }, // non-image: breaks the run
      { id: 703, data: 1003, boundary: 'newest' as const }, // after the text → must NOT absorb back into img1
    ];
    const src = pushedSource(fakeSource(500));
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    const createsAfterInit = t.createCount();

    src.pushLive(batch);
    await flush();
    expect(t.createCount() - createsAfterInit).toBe(3); // img1, txt, img3 mounted (img2 absorbed)
    expect(t.updateCount()).toBe(1); // only img2 absorbed into img1
    expect(t.dataOf(700)).toBe(1001 + 1002); // img1 grew by img2
    expect(content.querySelectorAll('[data-cb-id="701"]').length).toBe(0); // img2 has no own entry
    expect(content.querySelectorAll('[data-cb-id="703"]').length).toBe(1); // img3 is its OWN entry (no leapfrog)
  });

  // numAbsorb that also propagates clientMessageIds — mirrors absorbAlbumTail's cid-union contract: when an absorbed
  // item is a self-sent confirm, its cid is carried onto the merged album so reconcileOptimistic removes the matching
  // optimistic bubble. (The plain numAbsorb above models pure-incoming absorb, which has no cids.)
  function numAbsorbWithCids(
    target: CbItem<number>,
    incoming: CbItem<number>,
  ): CbItem<number> | null {
    if (target.data < 1000 || incoming.data < 1000) return null;
    const cids = new Set<string>();
    if (target.clientMessageId) cids.add(target.clientMessageId);
    if (target.clientMessageIds)
      for (const c of target.clientMessageIds) cids.add(c);
    if (incoming.clientMessageId) cids.add(incoming.clientMessageId);
    return {
      ...target,
      data: target.data + incoming.data,
      clientMessageIds: cids.size > 0 ? [...cids] : undefined,
    };
  }

  // Regression (the user report): a SELF-SENT image burst absorbed fine for incoming images but NOT for self-sent ones,
  // because every self-sent real is a confirm (its cid matches an in-flight optimistic) and absorb was gated on
  // !confirm. Now a confirm absorbs into the running album, its cid rides onto the album (clientMessageIds), and
  // reconcileOptimistic removes its optimistic — so a self-sent burst collapses into one album, no separate bubbles.
  it('self-sent image burst across SEPARATE signals absorbs into one album; each optimistic reconciled (no duplicate)', async () => {
    const t = trackingHooks();
    const hooks = { ...t.hooks, absorbTail: numAbsorbWithCids };
    const batches: CbItem<number>[][] = [
      [
        {
          id: 600,
          data: 1001,
          clientMessageId: 'cid-a',
          boundary: 'newest' as const,
        },
      ],
      [
        {
          id: 601,
          data: 1002,
          clientMessageId: 'cid-b',
          boundary: 'newest' as const,
        },
      ],
    ];
    const src = pushedSource(fakeSource(500));
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();

    // Send image A: optimistic bubble at the tail tracked by cid-a. The pre-existing newest (m-499, data 499 < 1000) is
    // NOT an image, so real-a cannot absorb → it mounts as a confirm (resortTarget) and reconciles opt-a.
    scroller.insertAfter(
      499,
      { id: -1, data: -1, clientMessageId: 'cid-a' },
      { optimistic: true },
    );
    src.pushLive(batches.shift()!);
    await flush(); // real-a confirms cid-a
    expect(content.querySelectorAll('[data-cb-id="-1"]').length).toBe(0); // opt-a reconciled (removed)
    expect(content.querySelectorAll('[data-cb-id="600"]').length).toBe(1); // real-a mounted once
    expect(
      content
        .querySelector('[data-cb-id="600"]')
        ?.classList.contains('cb-confirmed'),
    ).toBe(true);
    animEnd('600');

    // Send image B: another optimistic (cid-b). real-b's target IS real-a (an image) → it ABSORBS instead of mounting.
    const createsBeforeB = t.createCount();
    scroller.insertAfter(
      600,
      { id: -1, data: -1, clientMessageId: 'cid-b' },
      { optimistic: true },
    );
    src.pushLive(batches.shift()!);
    await flush(); // real-b absorbed into real-a
    expect(t.createCount()).toBe(createsBeforeB + 1); // only opt-b created (real-b ABSORBED, not mounted)
    expect(t.updateCount()).toBe(1); // real-a morphed in place
    expect(t.dataOf(600)).toBe(1001 + 1002); // merged data
    expect(content.querySelectorAll('[data-cb-id="601"]').length).toBe(0); // no separate real-b bubble
    expect(content.querySelectorAll('[data-cb-id="-1"]').length).toBe(0); // opt-b reconciled (cid-b rode onto the album)
    expect(content.querySelectorAll('[data-cb-id="600"]').length).toBe(1); // the album endures
  });

  // An absorbed-only demand must still report progress so the demand callback runs optimistic reconciliation — otherwise
  // opt-b would orphan. This is the same flow as the test above, isolated to the B signal with an explicit mount-count
  // check that mounted.length did NOT grow (the only progress was the absorb).
  it('a pure-absorb signal reports progress (n>0) even though mounted[] did not grow → reconcile still runs', async () => {
    const t = trackingHooks();
    const hooks = { ...t.hooks, absorbTail: numAbsorbWithCids };
    const batches: CbItem<number>[][] = [
      [
        {
          id: 600,
          data: 1001,
          clientMessageId: 'cid-a',
          boundary: 'newest' as const,
        },
      ],
      [
        {
          id: 601,
          data: 1002,
          clientMessageId: 'cid-b',
          boundary: 'newest' as const,
        },
      ],
    ];
    const src = pushedSource(fakeSource(500));
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    scroller.insertAfter(
      499,
      { id: -1, data: -1, clientMessageId: 'cid-a' },
      { optimistic: true },
    );
    src.pushLive(batches.shift()!);
    await flush();
    const mountedAfterA = scroller.getInfo().mounted;
    // Add opt-b BEFORE its real arrives, then deliver real-b in a pure-absorb signal.
    scroller.insertAfter(
      600,
      { id: -1, data: -1, clientMessageId: 'cid-b' },
      { optimistic: true },
    );
    src.pushLive(batches.shift()!);
    await flush();
    // mounted[] count is UNCHANGED (real-b absorbed, no new entry), yet opt-b was still reconciled → reconcile ran.
    expect(scroller.getInfo().mounted).toBe(mountedAfterA);
    expect(content.querySelectorAll('[data-cb-id="-1"]').length).toBe(0); // opt-b removed (not orphaned)
  });

  it('a source notification at a trimmed newer end caches only without loading or mounting', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush(); // scroll up → noNewer=false
    expect(scroller.getInfo().noNewer).toBe(false);
    const mountedBefore = scroller.getInfo().mounted;
    const newersBefore = src.newers();
    await flush();
    expect(scroller.getInfo().mounted).toBe(mountedBefore); // nothing mounted (cached only; loaded on scroll-back)
    expect(src.newers()).toBe(newersBefore); // getNewer not called (gate: !noNewer → return)
  });

  it('Phase C: removeItem(mountedId) plays cb-leave then unmounts on animationend; returns 1', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    const mountedBefore = scroller.getInfo().mounted;
    const n = scroller.removeItem(450);
    expect(n).toBe(1);
    const el = content.querySelector<HTMLElement>('[data-cb-id="450"]');
    expect(el?.classList.contains('cb-leave')).toBe(true);
    expect(scroller.getInfo().mounted).toBe(mountedBefore); // still mounted during the animation
    animEnd('450');
    await flush();
    expect(scroller.getInfo().mounted).toBe(mountedBefore - 1);
    expect(content.querySelector('[data-cb-id="450"]')).toBeNull();
  });

  it('Phase C: removeItem(not-mounted) returns 0 with no mutation', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    const mountedBefore = scroller.getInfo().mounted;
    expect(scroller.removeItem(9999)).toBe(0);
    expect(scroller.removeItem([9999, 8888])).toBe(0);
    expect(scroller.getInfo().mounted).toBe(mountedBefore);
  });

  it('Phase C: removeItem(array) removes multiple concurrently; an album-member id resolves to the album item', async () => {
    const { hooks } = controllableHooks();
    const mergeItems = (items: CbItem<number>[]): CbItem<number>[] => {
      // collapse m-450,451,452 into one album
      const out: CbItem<number>[] = [];
      let i = 0;
      while (i < items.length) {
        const a = items[i],
          b = items[i + 1],
          c = items[i + 2];
        if (a.id === 450 && b && b.id === 451 && c && c.id === 452) {
          out.push({ ...a, ids: [450, 451, 452] });
          i += 3;
        } else {
          out.push(a);
          i++;
        }
      }
      return out;
    };
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks: { ...hooks, mergeItems },
      source: fakeSource(500),
    });
    await scroller.init();
    const mountedBefore = scroller.getInfo().mounted;
    // m-451 is a non-head album member → resolves to the album item (m-450..452); m-460 is a separate item.
    const n = scroller.removeItem([451, 460]);
    expect(n).toBe(2); // dedup: the album counts once
    for (const id of ['450', '460']) animEnd(id);
    await flush();
    expect(scroller.getInfo().mounted).toBe(mountedBefore - 2);
    expect(content.querySelector('[data-cb-id="450"]')).toBeNull(); // whole album gone
  });

  it('Phase C: while a cb-leave is in flight, balance is deferred; it resumes on animationend', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    const getsBefore = src.gets();
    scroller.removeItem(400); // cb-leave, animating=1
    viewport.scrollTop = 0; // top edge → loadOlder would fire if balance ran
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.gets()).toBeGreaterThan(getsBefore); // demand subscription is not animation-gated
    animEnd('400');
    await flush();
    expect(src.gets()).toBeGreaterThan(getsBefore);
  });

  it('Phase C: removeItem above the viewport compensates scrollTop (-= height) on animationend', async () => {
    const { hooks } = controllableHooks(); // 100px/item
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init(); // pinned to bottom; m-400 (top 0) is above the viewport
    const stBefore = viewport.scrollTop;
    scroller.removeItem(400); // above the fold
    animEnd('400');
    await flush();
    expect(viewport.scrollTop).toBe(stBefore - 100); // pinned: content below shifted up by the removed height
  });

  // ── Tail cap: persistent non-message element at the newer edge (mirrors the top ghost; never in mounted[]) ──

  it('tail cap: always the last child of content, exactly one, after init', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    const caps = content.querySelectorAll('.cb-tail-cap');
    expect(caps.length).toBe(1);
    expect(content.lastElementChild).toBe(caps[0]); // always last: every append inserts before it
    expect(caps[0].querySelector('.cb-edge-status-ring')).not.toBeNull();
  });

  it('newer demand failure becomes an amber manual retry and ordinary balance does not retry', async () => {
    const { hooks } = controllableHooks();
    let requests = 0;
    const source = fakeSource(1);
    source.requestNewer = () => {
      requests++;
      return requests === 1
        ? of({ kind: 'error', error: new Error('offline') })
        : of({
            kind: 'items',
            items: [{ id: 1, data: 1, boundary: 'newest' }],
          });
    };
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source,
    });
    await scroller.init();
    await flush();

    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    expect(requests).toBe(1);
    expect(cap.classList.contains('cb-tail-cap--failed')).toBeTrue();
    expect(cap.getAttribute('role')).toBe('button');
    expect(cap.getAttribute('aria-label')).toContain('Retry');
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(requests).toBe(1);

    cap.click();
    await flush();
    expect(requests).toBeGreaterThanOrEqual(2);
    expect(cap.classList.contains('cb-tail-cap--failed')).toBeFalse();
  });

  it('cancels the persistent newer demand after leaving the lower load-more region', async () => {
    const { hooks } = controllableHooks();
    let cancelled = 0;
    const source = fakeSource(100);
    source.requestNewer = () =>
      new Observable(() => {
        return () => {
          cancelled++;
        };
      });
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source,
    });
    await scroller.init();
    await flush();
    expect(content.querySelector('.cb-tail-cap--loading')).toBeNull();
    expect(content.querySelector('.cb-tail-cap--gap')).not.toBeNull();

    viewport.scrollTop = 3000;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(cancelled).toBe(1);
  });

  it('demand invariant: repeated viewport notifications keep one active demand per direction', async () => {
    const { hooks } = controllableHooks();
    const source = fakeSource(500);
    let requests = 0;
    source.requestNewer = () => {
      requests++;
      return testDemand(() => new Promise(() => {}));
    };
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source,
    });
    await scroller.init();
    viewport.dispatchEvent(new Event('scroll'));
    viewport.dispatchEvent(new Event('scroll'));
    viewport.dispatchEvent(new Event('scroll'));
    await flush();

    expect(requests).toBe(1);
    expect(edgeState(scroller, 'newer').active).not.toBeNull();
  });

  it('demand invariant: a cancelled stale completion cannot mount or clear its replacement', async () => {
    const { hooks } = controllableHooks();
    const source = fakeSource(500);
    const resolvers: Array<(result: CbDemandResult<number>) => void> = [];
    source.requestNewer = () =>
      new Observable((subscriber) => {
        // Deliberately retain this sender after teardown; RxJS still prevents delivery to the closed observer.
        resolvers.push((result) => subscriber.next(result));
      });
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source,
    });
    await scroller.init();
    await flush();
    expect(resolvers.length).toBe(1);

    viewport.scrollTop = 3000;
    viewport.dispatchEvent(new Event('scroll')); // cancels demand #1
    viewport.scrollTop = content.scrollHeight - viewport.clientHeight;
    viewport.dispatchEvent(new Event('scroll')); // starts demand #2 immediately
    await flush();
    expect(resolvers.length).toBe(2);
    const replacement = edgeState(scroller, 'newer').active;

    resolvers[0]({ kind: 'items', items: [{ id: 700, data: 700 }] });
    await flush();
    expect(content.querySelector('[data-cb-id="700"]')).toBeNull();
    expect(edgeState(scroller, 'newer').active).toBe(replacement);
  });

  it('demand invariant: an error preserves boundaries and retry creates exactly one replacement', async () => {
    const { hooks } = controllableHooks();
    const source = fakeSource(500);
    let requests = 0;
    source.requestNewer = () => {
      requests++;
      return requests === 1
        ? of({ kind: 'error', error: new Error('offline') })
        : testDemand(() => new Promise(() => {}));
    };
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source,
    });
    await scroller.init();
    const boundaryBefore = scroller.getInfo().noNewer;
    await flush();
    expect(scroller.getInfo().noNewer).toBe(boundaryBefore);

    scroller.retryNewer();
    scroller.retryNewer();
    await flush();
    expect(requests).toBe(2);
    expect(edgeState(scroller, 'newer').active).not.toBeNull();
  });

  it('newest highlight intent is cancelled on lower-region exit, re-seed, and destroy', async () => {
    const { hooks } = controllableHooks();
    const source = fakeSource(5000);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source,
    });
    await scroller.init({ startMsgId: 2500, anchor: 'center' });
    source.requestNewer = () => testDemand(() => new Promise(() => {}));

    scroller.scrollToBottom(true);
    expect(newestHighlightPending(scroller)).toBeTrue();
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    expect(newestHighlightPending(scroller)).toBeFalse();

    scroller.scrollToBottom(true);
    void scroller.scrollToIndex(100, 'center');
    expect(newestHighlightPending(scroller)).toBeFalse();

    scroller.scrollToBottom(true);
    scroller.destroy();
    expect(newestHighlightPending(scroller)).toBeFalse();
    scroller = undefined;
  });

  it('newest highlight intent is cancelled when its newer demand fails', async () => {
    const { hooks } = controllableHooks();
    const source = fakeSource(5000);
    let resolveNewer!: (result: CbDemandResult<number>) => void;
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source,
    });
    await scroller.init({ startMsgId: 2500, anchor: 'center' });
    source.requestNewer = () =>
      new Observable((subscriber) => {
        resolveNewer = (result) => subscriber.next(result);
      });
    scroller.scrollToBottom(true);
    expect(newestHighlightPending(scroller)).toBeTrue();

    resolveNewer({ kind: 'error', error: new Error('offline') });
    await flush();
    expect(newestHighlightPending(scroller)).toBeFalse();
  });

  it('tail cap: gap mode at the global newest (noNewer) — cb-tail-cap--gap, height measured + folded into totalH', async () => {
    const { hooks } = controllableHooks(); // 100px/item
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init(); // pinned to bottom → noNewer=true
    expect(scroller.getInfo().noNewer).toBe(true);
    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    expect(cap.classList.contains('cb-tail-cap--gap')).toBe(true);
    expect(cap.classList.contains('cb-tail-cap--loading')).toBe(false);
    expect(cap.offsetHeight).toBe(14); // MEASURED: CSS owns the dimension, the kernel reads offsetHeight
    expect(sumChildrenHeight(content)).toBe(100 * 100 + 14); // cap height folded into the content total
  });

  it('tail cap: async aggregate growth follows bottom through the shared anchor logic', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    let capH = cap.offsetHeight;
    Object.defineProperty(cap, 'offsetHeight', {
      configurable: true,
      get: () => capH,
    });
    const before = viewport.scrollTop;

    capH += 120;
    (scroller as unknown as { onTailCapResize: () => void }).onTailCapResize();

    expect(viewport.scrollTop).toBe(before + 120);
    expect(scroller.getInfo().atBottom).toBe(true);
  });

  it('tail cap: an idle newer waiter after a mid-history jump stays a quiet gap', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(5000),
    });
    await scroller.init({ startMsgId: 2500, anchor: 'center' }); // mid-history → noNewer=false
    expect(scroller.getInfo().noNewer).toBe(false);
    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    expect(cap.classList.contains('cb-tail-cap--loading')).toBe(false);
    expect(cap.classList.contains('cb-tail-cap--gap')).toBe(true);
    expect(cap.offsetHeight).toBe(14);
  });

  it('tail cap: an idle waiter remains a gap while scrollToBottom reaches newest', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init(); // noNewer=true → gap
    scroller.scrollToIndex(100, 'center'); // re-seed mid-history → noNewer=false → loading
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    expect(
      content
        .querySelector('.cb-tail-cap')!
        .classList.contains('cb-tail-cap--gap'),
    ).toBe(true);
    scroller.scrollToBottom(); // the lower-region demand chain reaches the global newest
    await waitFor(
      () => scroller!.getInfo().noNewer,
      'scrollToBottom to reach the newest boundary',
    );
    expect(scroller.getInfo().noNewer).toBe(true);
    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    expect(cap.classList.contains('cb-tail-cap--gap')).toBe(true);
    expect(cap.offsetHeight).toBe(14); // height re-measured 48→14 on the batch that reached newest
  });

  it('tail cap: never in mounted[] — newestId is the last real item, the cap carries no data-cb-id', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init();
    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    expect(cap.dataset['cbId']).toBeUndefined(); // not a rendered item → no cursor corruption
    expect(scroller.getInfo().newestId).toBe(499); // cursor is the last REAL item, never the cap
  });

  it('tail cap: persists across a re-seed (unmountAll keeps it; still exactly one after a jump)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(5000),
    });
    await scroller.init();
    expect(content.querySelectorAll('.cb-tail-cap').length).toBe(1);
    scroller.scrollToIndex(100, 'center'); // re-seed: unmountAll does NOT remove the cap
    await flush();
    expect(content.querySelectorAll('.cb-tail-cap').length).toBe(1); // reused, not duplicated
    expect(content.lastElementChild?.classList.contains('cb-tail-cap')).toBe(
      true,
    );
  });

  it('tail cap: optimistic insert at the tail while noNewer stays gap (no phantom spinner under a sent message)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init(); // noNewer=true
    scroller.insertAfter(499, { id: -1, data: -1 }); // transient inserted before the cap
    const cap = content.querySelector<HTMLElement>('.cb-tail-cap')!;
    expect(cap.classList.contains('cb-tail-cap--gap')).toBe(true); // still gap, NOT loading
    expect(content.lastElementChild).toBe(cap); // cap still last
    expect(content.querySelector('[data-cb-id="-1"]')?.nextElementSibling).toBe(
      cap,
    ); // transient before the cap
  });

  it('tail cap: destroy removes it (content fully empty)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
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
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init(); // pinned to bottom with vh=600
    expect(scroller.getInfo().atBottom).toBe(true);
    const total = content.scrollHeight; // unchanged by a vh-only resize
    vh.set(300); // keyboard shrinks the layout viewport
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
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init({ startMsgId: 2500, anchor: 'center' }); // mid-history, NOT at bottom
    const stBefore = viewport.scrollTop;
    const getsBefore = src.gets();
    const newersBefore = src.newers();
    vh.set(300); // keyboard shrinks the viewport
    reflow(scroller);
    await flush();
    expect(viewport.scrollTop).toBe(stBefore); // absolute scrollTop unchanged → reading position preserved
    expect(src.gets()).toBe(getsBefore); // no loadOlder
    expect(src.newers()).toBe(newersBefore); // no loadNewer
  });

  // The pin the reflow issues writes scrollTop → fires an async scroll event after `shifting` has reset. Without the
  // suppress guard that scroll event re-arms balance and (when noNewer=false) loadNewer at the bottom — the visible
  // jitter during a keyboard shrink. Setup: scroll up so trimNewer opens the newer end (noNewer=false), sit at the
  // window bottom (atBottom true), then shrink + reflow and dispatch the pin's scroll event.
  it('resize: shrink at the bottom (noNewer=false) → suppress guard swallows the pin scroll event, no loadNewer', async () => {
    const { hooks } = controllableHooks();
    const vh = mutableVh(viewport, 600);
    const src = fakeSource(500);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init(); // m-400..m-499 pinned, noNewer=true
    viewport.scrollTop = 0; // scroll up → loadOlder + trimNewer opens the newer end
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    // sit at the window bottom (atBottom true, noNewer false) WITHOUT dispatching a scroll event (no balance yet):
    viewport.scrollTop = content.scrollHeight - 600;
    expect(scroller.getInfo().atBottom).toBe(true);
    const newersBefore = src.newers();
    vh.set(300); // keyboard shrinks the viewport → reflow pins + arms the suppress guard
    reflow(scroller);
    viewport.dispatchEvent(new Event('scroll')); // the pin's async scroll event
    await flush();
    expect(src.newers()).toBe(newersBefore); // guard swallowed it → no balance, no loadNewer (was the jitter source)
  });

  // Grow direction (vh increases, e.g. keyboard dismissed). Only shrink was tested above; the reflow must re-pin to
  // the (unchanged) bottom when pinned, and leave scrollTop untouched mid-screen.
  it('resize: grow while pinned to bottom → re-pins to the new bottom (scrollHeight unchanged, vh up)', async () => {
    const { hooks } = controllableHooks();
    const vh = mutableVh(viewport, 600);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(500),
    });
    await scroller.init(); // pinned, vh=600
    expect(scroller.getInfo().atBottom).toBe(true);
    const total = content.scrollHeight; // a vh-only resize does not change content height
    vh.set(800); // viewport grows
    reflow(scroller);
    expect(viewport.scrollTop).toBe(total - 800);
    expect(scroller.getInfo().atBottom).toBe(true);
  });

  it('resize: grow mid-history → scrollTop unchanged (reading position preserved), no load/trim', async () => {
    const { hooks } = controllableHooks();
    const vh = mutableVh(viewport, 600);
    const src = fakeSource(5000);
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init({ startMsgId: 2500, anchor: 'center' }); // mid-history, NOT at bottom
    const stBefore = viewport.scrollTop;
    const getsBefore = src.gets();
    const newersBefore = src.newers();
    vh.set(800); // viewport grows
    reflow(scroller);
    await flush();
    expect(viewport.scrollTop).toBe(stBefore); // absolute scrollTop unchanged → reading position preserved
    expect(src.gets()).toBe(getsBefore);
    expect(src.newers()).toBe(newersBefore);
  });

  // ── reconcilePending: in-place failure morph + FLIP reorder (sending→failed, sink to tail, stable clientMessageId) ──

  it('reconcilePending morphs a failed send IN PLACE (same node, update not recreate, no cb-leave/cb-enter)', async () => {
    const t = trackingHooks();
    const pending: CbItem<number>[] = [];
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks: t.hooks,
      source: pendingSource(500, pending),
    });
    await scroller.init();
    const opt: CbItem<number> = { id: -1, data: 1, clientMessageId: 'cid-0' };
    pending.push(opt);
    scroller.insertAfter(499, opt, { optimistic: true }); // optimistic bubble at the tail
    animEnd('-1'); // drain its cb-enter
    const elBefore = content.querySelector('[data-cb-id="-1"]');
    const mountedBefore = scroller.getInfo().mounted;
    const createsBefore = t.createCount();
    const updatesBefore = t.updateCount();

    // The source flips status (a NEW data ref, same id/clientMessageId) — mirrors MockItemSource.failPending.
    pending[0] = { id: -1, data: 2, clientMessageId: 'cid-0' };
    await scroller.reconcilePending();

    expect(content.querySelector('[data-cb-id="-1"]')).toBe(elBefore); // SAME DOM node (no destroy+recreate)
    expect(t.createCount()).toBe(createsBefore); // createItem NOT re-called
    expect(t.updateCount()).toBe(updatesBefore + 1); // update applied
    expect(t.dataOf(-1)).toBe(2); // new data rendered
    expect(scroller.getInfo().mounted).toBe(mountedBefore); // mount count unchanged
    expect(
      content.querySelector('[data-cb-id="-1"]')?.classList.contains('cb-move'),
    ).toBe(false); // single send already at the tail → no move
  });

  it('reconcilePending FLIP-reorders a failed send to the tail; the shoved sibling animates too (no hard cut)', async () => {
    const { hooks } = controllableHooks();
    const pending: CbItem<number>[] = [];
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: pendingSource(500, pending),
    });
    await scroller.init();
    const A: CbItem<number> = { id: -1, data: 10, clientMessageId: 'cid-A' };
    const B: CbItem<number> = { id: -2, data: 20, clientMessageId: 'cid-B' };
    pending.push(A, B);
    scroller.insertAfter(499, A, { optimistic: true });
    animEnd('-1');
    scroller.insertAfter(-1, B, { optimistic: true });
    animEnd('-2');
    // Tail was [..., m-499, cid-A, cid-B]. Source fails A and sinks it to the end → pending order [cid-B, cid-A].
    pending.splice(
      0,
      2,
      { id: -2, data: 20, clientMessageId: 'cid-B' },
      { id: -1, data: 11, clientMessageId: 'cid-A' },
    );
    await scroller.reconcilePending();

    const ids = Array.from(content.children)
      .filter((c) => (c as HTMLElement).dataset['cbId'])
      .map((c) => (c as HTMLElement).dataset['cbId'] as string);
    const i = ids.lastIndexOf('499');
    expect(ids.slice(i + 1)).toEqual(['-2', '-1']); // A sunk to the tail; reals above untouched
    // BOTH animate: A slid down to the tail AND B shoved up by A's height (the sibling-must-animate regression).
    expect(
      content.querySelector('[data-cb-id="-1"]')?.classList.contains('cb-move'),
    ).toBe(true);
    expect(
      content.querySelector('[data-cb-id="-2"]')?.classList.contains('cb-move'),
    ).toBe(true);
    animEnd('-1');
    animEnd('-2');
    expect(
      content.querySelector('[data-cb-id="-1"]')?.classList.contains('cb-move'),
    ).toBe(false);
    expect(
      content.querySelector('[data-cb-id="-2"]')?.classList.contains('cb-move'),
    ).toBe(false);
  });

  // The FLIP reorder is transform-only (cb-move); it must NOT touch scrollTop. DOM order is asserted above; this
  // guards the anchor rewrite's promise that a pure tail reorder neither compensates nor pins.
  it('reconcilePending FLIP reorder does not move scrollTop (transform-only; the visible content stays put)', async () => {
    const { hooks } = controllableHooks();
    const pending: CbItem<number>[] = [];
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: pendingSource(500, pending),
    });
    await scroller.init();
    const A: CbItem<number> = { id: -1, data: 10, clientMessageId: 'cid-A' };
    const B: CbItem<number> = { id: -2, data: 20, clientMessageId: 'cid-B' };
    pending.push(A, B);
    scroller.insertAfter(499, A, { optimistic: true });
    animEnd('-1');
    scroller.insertAfter(-1, B, { optimistic: true });
    animEnd('-2');
    scroller.scrollToBottom(); // pinned at the bottom (optimistic tail visible)
    const stBefore = viewport.scrollTop;
    // Source fails A and sinks it to the end → pending order [cid-B, cid-A] (a reorder, no height change).
    pending.splice(
      0,
      2,
      { id: -2, data: 20, clientMessageId: 'cid-B' },
      { id: -1, data: 11, clientMessageId: 'cid-A' },
    );
    await scroller.reconcilePending();
    expect(viewport.scrollTop).toBe(stBefore); // FLIP is transform-only; scrollTop must not change
    animEnd('-1');
    animEnd('-2');
  });

  it('reconcilePending morphs a retried send back in place at its position (no remount, no move)', async () => {
    const t = trackingHooks();
    const pending: CbItem<number>[] = [];
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks: t.hooks,
      source: pendingSource(500, pending),
    });
    await scroller.init();
    pending.push({ id: -1, data: 10, clientMessageId: 'cid-A' });
    scroller.insertAfter(499, pending[0], { optimistic: true });
    animEnd('-1');
    pending[0] = { id: -1, data: 11, clientMessageId: 'cid-A' }; // fail it
    await scroller.reconcilePending();
    animEnd('-1');
    const elFailed = content.querySelector('[data-cb-id="-1"]');
    const createsBeforeRetry = t.createCount();

    pending[0] = { id: -1, data: 12, clientMessageId: 'cid-A' }; // retry: flip back, SAME id/position
    await scroller.reconcilePending();

    expect(content.querySelector('[data-cb-id="-1"]')).toBe(elFailed); // same node across fail+retry
    expect(t.createCount()).toBe(createsBeforeRetry); // no remount on retry
    expect(
      content.querySelector('[data-cb-id="-1"]')?.classList.contains('cb-move'),
    ).toBe(false); // single pending → no reorder
    expect(t.dataOf(-1)).toBe(12);
  });

  it('destroy during a FLIP move drains cleanly (moveTimer cleared, animating not leaked)', async () => {
    const { hooks } = controllableHooks();
    const pending: CbItem<number>[] = [];
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: pendingSource(500, pending),
    });
    await scroller.init();
    pending.push(
      { id: -1, data: 10, clientMessageId: 'cid-A' },
      { id: -2, data: 20, clientMessageId: 'cid-B' },
    );
    scroller.insertAfter(499, pending[0], { optimistic: true });
    animEnd('-1');
    scroller.insertAfter(-1, pending[1], { optimistic: true });
    animEnd('-2');
    pending.splice(
      0,
      2,
      { id: -2, data: 20, clientMessageId: 'cid-B' },
      { id: -1, data: 11, clientMessageId: 'cid-A' },
    );
    await scroller.reconcilePending();
    expect(
      content.querySelector('[data-cb-id="-1"]')?.classList.contains('cb-move'),
    ).toBe(true); // move in flight
    expect(() => scroller?.destroy()).not.toThrow(); // teardown mid-move (cancelEntryAnim clears moveTimer)
    scroller = undefined; // afterEach will skip the now-destroyed scroller
  });

  // ── Empty thread (0 data): first send mounts, then confirms by replacing the optimistic bubble ──

  it('init on an empty source → noOlder & noNewer true (pinned to bottom), nothing mounted', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(0),
    });
    await scroller.init();
    const info = scroller.getInfo();
    expect(info.mounted).toBe(0);
    expect(info.noOlder).toBe(true);
    expect(info.noNewer).toBe(true); // empty thread reports "pinned to bottom" → first send mounts synchronously
    expect(info.oldestId).toBeNull();
    expect(info.newestId).toBeNull();
  });

  it('insertAfter into an empty window → mounts the sole entry (first message in an empty thread)', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: fakeSource(0),
    });
    await scroller.init();
    const ok = scroller.insertAfter(
      0,
      { id: -1, data: 7, clientMessageId: 'cid-1' },
      { optimistic: true },
    );
    expect(ok).toBe(true);
    expect(scroller.getInfo().mounted).toBe(1);
    expect(content.querySelector('[data-cb-id="-1"]')).not.toBeNull();
  });

  it('empty thread: optimistic send → confirm signal → real replaces the optimistic bubble at the bottom', async () => {
    const src = pushedSource(fakeSource(0));
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    expect(scroller.getInfo().mounted).toBe(0);
    expect(scroller.getInfo().noNewer).toBe(true);

    // First send into the empty thread: the optimistic bubble mounts as the sole entry.
    const opt: CbItem<number> = { id: -1, data: 42, clientMessageId: 'cid-1' };
    expect(scroller.insertAfter(0, opt, { optimistic: true })).toBe(true);
    expect(scroller.getInfo().mounted).toBe(1);
    expect(content.querySelector('[data-cb-id="-1"]')).not.toBeNull();

    // Server confirm: cache the real (fresh server id, SAME clientMessageId) then deliver the WS signal.
    src.pushLive([
      { id: 0, data: 42, clientMessageId: 'cid-1', boundary: 'newest' },
    ]);
    await flush();

    // The optimistic duplicate is reconciled away; the real is the sole mounted item, pinned at the bottom, cb-confirmed.
    const info = scroller.getInfo();
    expect(info.mounted).toBe(1);
    expect(content.querySelector('[data-cb-id="-1"]')).toBeNull(); // optimistic gone
    const realEl = content.querySelector<HTMLElement>('[data-cb-id="0"]');
    expect(realEl).not.toBeNull(); // real shown
    expect(realEl?.classList.contains('cb-confirmed')).toBe(true); // sent-check choreography gated on this class
    expect(info.newestId).toBe(0);
    expect(info.noNewer).toBe(true);
    expect(info.atBottom).toBe(true); // first message sits at the bottom
  });

  it('empty thread: incoming first message (receiver flow — no optimistic bubble) mounts via the init(-1) fallback', async () => {
    // Receiver-side regression for the reported bug: an empty thread (mounted === []) receives its FIRST message
    // live via SSE. Unlike the sender flow above (which pre-mounts an optimistic bubble → mounted.length === 1 when
    // the signal fires), the receiver has nothing mounted. loadNewer(true) must NOT bail on `mounted.length === 0` —
    // it must fall through to the init(-1) newest-page fallback and mount the just-cached real. Pre-fix the guard
    // returned 0 and the first message was silently dropped (empty chatbox); only the SECOND message showed, because
    // by then mounted.length > 0.
    const src = pushedSource(fakeSource(0));
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    expect(scroller.getInfo().mounted).toBe(0);
    expect(scroller.getInfo().noNewer).toBe(true);

    // Receiver: the first message arrives live (SSE → repo cache → signal). NO optimistic bubble is mounted.
    src.pushLive([{ id: 0, data: 42, boundary: 'newest' }]);
    await flush();

    // The first incoming message MUST mount and pin to the bottom — pre-fix this stayed mounted===0.
    const info = scroller.getInfo();
    expect(info.mounted).toBe(1);
    expect(content.querySelector('[data-cb-id="0"]')).not.toBeNull();
    expect(info.newestId).toBe(0);
    expect(info.noNewer).toBe(true);
    expect(info.atBottom).toBe(true);
  });

  it('empty thread: first message arriving DURING the init-fetch window is saved + replayed (not dropped)', async () => {
    // The same guard bug also defeated the primeAndReplay race path: a signal that lands during init's fetch window
    // is saved, then replayed once init primes — but the replay routes back into loadNewer(true) on mounted===[],
    // which pre-fix bailed at the guard. One root cause, two symptoms; this test pins the second. Mirrors the
    // non-empty "signal in the init-fetch window" test, but the snapshot resolves EMPTY (a brand-new thread).
    let resolveInitFn: ((items: CbItem<number>[]) => void) | null = null;
    const base: CbSource<number> = {
      init: async (anchorId) => {
        if (anchorId !== -1) return [];
        return new Promise((r) => {
          resolveInitFn = r;
        });
      },
      requestOlder: () => testDemand(async () => [], true),
      requestNewer: () => testDemand(async () => []),
      pushLive: () => {},
      getPending: () => [],
      destroy: () => {},
    };
    const src = pushedSource(base);
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });

    const initP = scroller.init(); // source.init(-1) deferred → the init-fetch window (state stays 'steady')
    await flush();
    expect(resolveInitFn).not.toBeNull(); // init's initial fetch is still in flight

    // The first message (id 0) arrives during the window + its signal fires (saved by runMessageSignal's !primed arm).
    src.pushLive([{ id: 0, data: 42, boundary: 'newest' }]);

    // init resolves with the EMPTY pre-arrival snapshot (id 0 missed it).
    resolveInitFn!([]);
    resolveInitFn = null;
    await initP;
    await flush();

    // primeAndReplay fired the saved signal → loadNewer(true) on the empty window → init(-1) fallback → id 0 mounted.
    const info = scroller.getInfo();
    expect(info.mounted).toBe(1);
    expect(content.querySelector('[data-cb-id="0"]')).not.toBeNull();
    expect(info.newestId).toBe(0);
    expect(info.atBottom).toBe(true);
  });

  it('single-message thread (count=1): the sole item is marked "both" → noOlder AND noNewer set, no wasted loads, no ghost', async () => {
    // A 1-message sequence: the source emits boundary:'both' for the sole item (it is both the global oldest and newest).
    const sole: CbItem<number> = { id: 0, data: 0, boundary: 'both' };
    let olderCalls = 0;
    let newerCalls = 0;
    const src: CbSource<number> = {
      init: async () => [{ ...sole }],
      requestOlder: () =>
        testDemand(async () => {
          olderCalls++;
          return [];
        }, true),
      requestNewer: () =>
        testDemand(async () => {
          newerCalls++;
          return [];
        }),
      pushLive: () => {},
      getPending: () => [],
      destroy: () => {},
    };
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks,
      source: src,
    });
    await scroller.init();
    const info = scroller.getInfo();
    expect(info.mounted).toBe(1);
    expect(info.oldestId).toBe(0);
    expect(info.newestId).toBe(0);
    // 'both' must set BOTH edges. Pre-fix, absorbBoundary's else-if matched neither 'oldest' nor 'newest' on a 'both'
    // item → noOlder stayed false → a single-message thread showed a permanent top ghost + triggered a wasted loadOlder.
    expect(info.noOlder).toBe(true);
    expect(info.noNewer).toBe(true);
    // Both edges known at init → no older fill. The lower region still owns one persistent newer waiter.
    expect(olderCalls).toBe(0);
    expect(newerCalls).toBe(1);
  });

  it('updateItemData morphs a mounted item in place (vs.update, no recreate) — object data, like ChatItemData', async () => {
    type D = { v: number };
    let creates = 0,
      updates = 0;
    const dataMap = new Map<number, D>();
    const hooks = {
      createItem: (item: CbItem<D>, _prev: CbItem<D> | null): CbElement<D> => {
        creates++;
        dataMap.set(item.id, item.data);
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', {
          configurable: true,
          get: () => 100,
        });
        return {
          el,
          onHeightChange: () => () => {},
          update: (n: CbItem<D>) => {
            updates++;
            dataMap.set(item.id, n.data);
          },
          destroy: () => {},
        };
      },
    };
    const items: CbItem<D>[] = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      data: { v: i },
    }));
    items[0] = { ...items[0], boundary: 'oldest' as const };
    items[19] = { ...items[19], boundary: 'newest' as const };
    const src: CbSource<D> = {
      init: async () => items.slice(),
      requestOlder: () => testDemand(async () => [], true),
      requestNewer: () => testDemand(async () => []),
      pushLive: () => {},
      getPending: () => [],
      destroy: () => {},
    };
    const s = new ChatBoxScroller<D>({ viewport, content, hooks, source: src });
    try {
      await s.init();
      const before = creates;
      expect(s.updateItemData(15, { v: 999 })).toBe(true);
      expect(updates).toBe(1);
      expect(creates).toBe(before); // in-place morph, NOT destroy+recreate
      expect(dataMap.get(15)).toEqual({ v: 999 });
    } finally {
      s.destroy();
    }
  });

  it('updateItemData returns false (no-op) when the id is not mounted', async () => {
    const t = trackingHooks();
    scroller = new ChatBoxScroller<number>({
      viewport,
      content,
      hooks: t.hooks,
      source: fakeSource(20),
    });
    await scroller.init();
    expect(scroller.updateItemData(9999, 1)).toBe(false);
    expect(t.updateCount()).toBe(0);
  });

  it('updateItemData is album-aware: any member id (item.ids) resolves to the album item', async () => {
    type D = { v: number };
    let updates = 0;
    const dataMap = new Map<number, D>();
    const hooks = {
      createItem: (item: CbItem<D>): CbElement<D> => {
        dataMap.set(item.id, item.data);
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', {
          configurable: true,
          get: () => 100,
        });
        return {
          el,
          onHeightChange: () => () => {},
          update: (n: CbItem<D>) => {
            updates++;
            dataMap.set(item.id, n.data);
          },
          destroy: () => {},
        };
      },
    };
    const album: CbItem<D> = {
      id: 10,
      data: { v: 10 },
      ids: [10, 11, 12],
      boundary: 'both',
    };
    const src: CbSource<D> = {
      init: async () => [album],
      requestOlder: () => testDemand(async () => [], true),
      requestNewer: () => testDemand(async () => []),
      pushLive: () => {},
      getPending: () => [],
      destroy: () => {},
    };
    const s = new ChatBoxScroller<D>({ viewport, content, hooks, source: src });
    try {
      await s.init();
      expect(s.updateItemData(11, { v: 77 })).toBe(true); // member 11 → album item (id 10)
      expect(updates).toBe(1);
      expect(dataMap.get(10)).toEqual({ v: 77 });
    } finally {
      s.destroy();
    }
  });
});
