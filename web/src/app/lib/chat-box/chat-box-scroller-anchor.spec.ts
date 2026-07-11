/**
 * ChatBoxScrollerAnchor（方案 A：借浏览器锚定）单元测试 —— array index-based。
 *
 * 重点验方案 A 与 B 的关键区别：loadOlder（顶部 prepend）/ 上方变化时内核**不写 scrollTop**
 *（交浏览器 overflow-anchor）。mock 环境无浏览器锚定，故断言「scrollTop 未被内核改动」即证明未补偿。
 *
 * mock source 用 numeric msgId 游标（0..N-1，0 最老），不再连续抽象 id —— 验证内核 index 与 source id 解耦。
 */
import { ChatBoxScrollerAnchor, CbElement, CbItem } from './chat-box-scroller-anchor';
import type { CbSource } from './cb-source';

/** content 子元素 offsetHeight 之和（验 totalH）。 */
function sumChildrenHeight(el: HTMLElement): number {
  let s = 0;
  for (const c of Array.from(el.children)) s += (c as HTMLElement).offsetHeight || 0;
  return s;
}

/** 可控 hooks：createItem(item)，每项高度固定。不依赖 id 数值（item.id 是 numeric msgId）。 */
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

/** Fake source：N 条 msg（0 最老 .. N-1 最新）。游标 getOlder/getNewer，升序返回。 */
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

/** 可控 init 的 source：init 返回手动 resolve 的 Promise（测连续跳转 gen 超越）。 */
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

/** 排空微任务（openAround/fillAround 多跳 async）。 */
async function flush(n = 30): Promise<void> { for (let i = 0; i < n; i++) await Promise.resolve(); }

/** 可控 source：getOlder 返回手动 resolve 的 Promise，测「getOlder 在途」时改 scrollTop（fling 反向）。 */
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
    // 普通 function return Promise（不用 async，避免多一层 thenable assimilation microtask 阻塞测试 flush）
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

describe('ChatBoxScrollerAnchor（方案 A · array index）', () => {
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

  it('init 取最新一批、贴底、窗口边界 msgId 正确', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const info = scroller.getInfo();
    expect(info.mounted).toBe(100);          // initBatch=100（100×100px=10000 > threshold 6000，不补批）
    expect(info.oldestId).toBe(400);      // 这批最老
    expect(info.newestId).toBe(499);      // 锚点=最新
    expect(info.atBottom).toBe(true);
  });

  it('方案 A：loadOlder 后 scrollTop【不被内核补偿】（与 B 的关键区别）', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    viewport.scrollTop = 50;
    const stBefore = viewport.scrollTop;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve(); // flush loadOlder
    await Promise.resolve();
    // 方案 A 不补偿：scrollTop 仍为滚到时的值（未被 += 新挂高度）
    expect(viewport.scrollTop).toBe(stBefore);
  });

  it('measurePending 移除挂载元素 cb-pending', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(content.querySelectorAll('.cb-pending').length).toBe(0);
  });

  // ── 阶段0：noOlder absorb 时机（revalidate 通过后才吸收，方案 A 同修）──

  it('阶段0：fling 反向时含 oldest 边界批不挂 → noOlder 不锁死、回顶仍能 getOlder', async () => {
    const { hooks } = controllableHooks();
    const src = controllableSource(120); // init 100 → 第一次 getOlder 返回 m-0..m-19（含 oldest=m-0）
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    expect(scroller.getInfo().noOlder).toBe(false);

    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    expect(src.isPending()).toBe(true);

    // fling 反向：离开顶边缘 + 方向 down
    viewport.scrollTop = 2000;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve();

    src.resolveOlder();
    await Promise.resolve();
    expect(scroller.getInfo().noOlder).toBe(false); // 修前会被锁 true（bug）

    const getsBefore = src.gets();
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    expect(src.gets()).toBeGreaterThan(getsBefore);
  });

  // ── 阶段1：骨架 item（cb-ghost，方案 A 同；不补偿 scrollTop）──

  it('阶段1：init 后顶部 mounted[0] 显 cb-ghost（未到最老），且仅一条', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const oldest = scroller.getInfo().oldestId!;
    expect(content.querySelector(`[data-cb-id="${oldest}"]`)?.classList.contains('cb-ghost')).toBe(true);
    expect(content.querySelectorAll('.cb-ghost').length).toBe(1);
  });

  it('阶段1：滚到全局最老（noOlder）→ cb-ghost 消失', async () => {
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

  it('loadOlder 截最新端 → noNewer 重置 false（loadNewer 可加载回，修向下滚/定位底部卡住）', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(scroller.getInfo().noNewer).toBe(true);
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve(); await Promise.resolve();
    expect(scroller.getInfo().noNewer).toBe(false);
  });

  it('destroy 清空挂载', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    scroller.destroy();
    expect(content.children.length).toBe(0);
  });

  // ── 跳转到指定 id（方案 A 与 B 跳转路径同构：openAround/fillAround/positionMounted 一致）──

  it('scrollToIndex 已挂载 → 按 anchor 定位（top/center/bottom）', async () => {
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

  it('init({startMsgId}) 中段 → 双向窗口围绕目标、居中（无 fill）', async () => {
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

  it('scrollToIndex 未挂载 → 重置窗口围绕 id（re-seed）、目标挂载并居中', async () => {
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

  it('近最旧跳转 → noOlder、上方不足 threshold/2 → 下方补偿到 threshold', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 5, anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noOlder).toBe(true);
    expect(info.newestId).toBe(105);
    expect(info.noNewer).toBe(false);
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000);
  });

  it('近最新跳转 → noNewer、下方不足 threshold/2 → 上方补偿到 threshold', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 4995, anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noNewer).toBe(true);
    expect(info.oldestId).toBe(4896);
    expect(info.noOlder).toBe(false);
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000);
  });

  it('极小会话跳转 → 两侧均到界、totalH<threshold、直接渲染', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(30) });
    await scroller.init({ startMsgId: 15, anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noOlder).toBe(true);
    expect(info.noNewer).toBe(true);
    expect(info.mounted).toBe(30);
  });

  it('短 item 跳转 → fill 循环向两侧补到 threshold/2', async () => {
    const { hooks } = controllableHooks(10);
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 2500, anchor: 'center' });
    expect(scroller.getInfo().mounted).toBeGreaterThan(100);
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000);
  });

  it('scrollToIndex highlight → 目标行加 cb-jump-highlight', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    scroller.scrollToIndex(450, 'top', true);
    const el = content.querySelector<HTMLElement>('[data-cb-id="450"]');
    expect(el?.classList.contains('cb-jump-highlight')).toBe(true);
  });

  // ── 补覆盖：scrollToTop / refresh / loadNewer（向下加载）/ openAround 边界 / gen 超越 ──

  it('scrollToTop → scrollTop=0', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(viewport.scrollTop).toBeGreaterThan(0);
    scroller.scrollToTop();
    expect(viewport.scrollTop).toBe(0);
  });

  it('refresh → 重测 vh + balance，不抛错、窗口仍可用', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(() => scroller!.refresh()).not.toThrow();
    scroller.scrollToIndex(scroller.getInfo().newestId!, 'top');
    expect(viewport.scrollTop).toBeGreaterThanOrEqual(0);
  });

  it('向下滚到底边缘 → loadNewer 触发 getNewer、newestId 向最新推进', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    await scroller.init(); // 贴底、noNewer=true
    viewport.scrollTop = 0; // 向上滚 → loadOlder → trimNewer → noNewer=false
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    const newestBefore = scroller.getInfo().newestId!;
    viewport.scrollTop = content.scrollHeight - 600; // 贴底 → loadNewer
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.newers()).toBeGreaterThan(0);
    expect(scroller.getInfo().newestId!).toBeGreaterThan(newestBefore);
  });

  it('openAround：source 返回不含目标的批 → 安全 no-op（不挂载、不崩溃）', async () => {
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

  it('连续两次跳转 → gen 守卫：在途的第一次被丢弃，最终窗口围绕第二次', async () => {
    const { hooks } = controllableHooks();
    const src = controllableInitSource(5000);
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    scroller.scrollToIndex(100, 'center'); // openAround#1（gen=1）
    scroller.scrollToIndex(200, 'center'); // openAround#2（++gen=2）
    expect(src.initPending()).toBe(2);
    src.resolveInit(src.batchAround(100)); // #1 → gen≠ → 丢弃
    src.resolveInit(src.batchAround(200)); // #2 → 挂 151..250
    await flush();
    const info = scroller.getInfo();
    expect(info.oldestId).toBe(151);
    expect(info.newestId).toBe(250);
  });

  // ── insertAfter：中段插入（不触发 balance；方案 A 不补偿 scrollTop —— 与 B 的关键区别）──

  it('insertAfter 未挂载 id → no-op（返回 false、不挂载、不加载）', async () => {
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

  it('insertAfter 中段 → 挂到 idx+1 正确 DOM 位（target 与后继之间）', async () => {
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

  it('insertAfter 用新 prev 重建后继；新项以 target 为 prev 仅创建一次', async () => {
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
    expect(succ.length).toBe(2);         // init 挂载 + rebuild
    expect(succ[1].prev).toBe(-1);    // 用新 prev 重建
  });

  it('方案 A：insertAfter 即便在视口上方也不补偿 scrollTop（浏览器 overflow-anchor 负责；mock 下即「未改动」）', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    await scroller.init(); // 贴底（scrollTop=9400）；m-400（top 0）在视口上方
    const stBefore = viewport.scrollTop;
    const ok = scroller.insertAfter(400, { id: -1, data: -1 });
    expect(ok).toBe(true);
    expect(viewport.scrollTop).toBe(stBefore); // 方案 A 不补偿（与 B 的 +=100 区别）
    expect(src.gets()).toBe(0);                 // 不触发 balance
    expect(src.newers()).toBe(0);
  });

  it('游标守卫：transient 到达末尾不污染 loadNewer（不误锁 noNewer）', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    viewport.scrollTop = 0; // 向上滚 → trimNewer → noNewer=false
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    const tailId = scroller.getInfo().newestId!;
    const ok = scroller.insertAfter(tailId, { id: -1, data: -1 }); // transient 成新末
    expect(ok).toBe(true);
    expect(scroller.getInfo().newestId).toBe(-1);
    // drain the cb-enter so the checkpoint is not deferred when scrolling to the bottom edge
    content.querySelector<HTMLElement>('[data-cb-id="-1"]')?.dispatchEvent(new Event('animationend'));
    viewport.scrollTop = content.scrollHeight - 600; // 滚到底边缘 → loadNewer
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.newers()).toBeGreaterThan(0);                      // getNewer called with the real cursor (skipped the transient)
    expect(scroller.getInfo().newestId).toBe(-1);              // transient stays at the tail (reals insert before the tail block)
    expect(scroller.getInfo().noNewer).toBe(false);               // NOT falsely locked (would be true without the guard)
    // reals were loaded before the transient: the item just newer than the original tail is now mounted
    expect(content.querySelector(`[data-cb-id="${tailId + 1}"]`)).not.toBeNull();
  });

  // ── Phase A/B/C (方案 A mirror): enter animation, transient-safe trim, settle, removeItem (no scrollTop compensation) ──

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

  it('Phase C (方案 A): removeItem does NOT compensate scrollTop (browser overflow-anchor owns the viewport)', async () => {
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
