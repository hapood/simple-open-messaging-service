/**
 * VirtualScrollerAnchor（方案 A：借浏览器锚定）单元测试 —— array index-based。
 *
 * 重点验方案 A 与 B 的关键区别：loadOlder（顶部 prepend）/ 上方变化时内核**不写 scrollTop**
 *（交浏览器 overflow-anchor）。mock 环境无浏览器锚定，故断言「scrollTop 未被内核改动」即证明未补偿。
 *
 * mock source 用 msgId 游标（'m-K'，K=0 最老），不再连续抽象 id —— 验证内核 index 与 source id 解耦。
 */
import { VirtualScrollerAnchor, VsElement, VsItem } from './virtual-scroller-anchor';
import type { VsSource } from './source';

/** 'm-K' → K（msgId 解析为序号，供 fakeSource 游标定位）。 */
function num(id: string | number): number { return Number(String(id).replace(/^m-/, '')); }

/** 可控 hooks：createItem(item)，每项高度固定。不依赖 id 数值（item.id 是 msgId 字符串）。 */
function controllableHooks(itemHeight = 100): { hooks: { createItem: (item: VsItem<number>, prev: VsItem<number> | null) => VsElement<number> } } {
  return {
    hooks: {
      createItem: (item): VsElement<number> => {
        void item;
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => itemHeight });
        return { el, estimateHeight: () => itemHeight, onHeightChange: () => () => {}, destroy: () => {} };
      },
    },
  };
}

/** Fake source：N 条 msg（'m-0'最老 .. 'm-(N-1)'最新）。游标 getOlder/getNewer，升序返回。 */
function fakeSource(N: number): VsSource<number> & { gets: () => number } {
  const itemAt = (i: number): VsItem<number> | undefined => {
    if (i < 0 || i >= N) return undefined;
    const boundary = i === 0 ? 'oldest' as const : i === N - 1 ? 'newest' as const : undefined;
    return boundary ? { id: `m-${i}`, data: i, boundary } : { id: `m-${i}`, data: i };
  };
  const slice = (lo: number, hi: number): VsItem<number>[] => {
    const out: VsItem<number>[] = [];
    for (let i = Math.max(0, lo); i < Math.min(N, hi); i++) { const it = itemAt(i); if (it) out.push(it); }
    return out;
  };
  let gets = 0;
  const src: VsSource<number> = {
    init: async (_r, older) => slice(N - older, N),
    getOlder: async (cursorId, count) => { gets++; const k = num(cursorId); return slice(k - count, k); },
    getNewer: async (cursorId, count) => { const k = num(cursorId); return slice(k + 1, k + 1 + count); },
    appendLive: (items) => items.map((it, i) => ({ ...it, id: `live-${i}`, boundary: 'newest' as const })),
    destroy: () => {},
  };
  return Object.assign(src, { gets: () => gets });
}

/** 可控 source：getOlder 返回手动 resolve 的 Promise，测「getOlder 在途」时改 scrollTop（fling 反向）。 */
function controllableSource(N: number): VsSource<number> & {
  gets: () => number; resolveOlder: (items?: VsItem<number>[]) => void; isPending: () => boolean;
} {
  const itemAt = (i: number): VsItem<number> | undefined => {
    if (i < 0 || i >= N) return undefined;
    const boundary = i === 0 ? 'oldest' as const : i === N - 1 ? 'newest' as const : undefined;
    return boundary ? { id: `m-${i}`, data: i, boundary } : { id: `m-${i}`, data: i };
  };
  const slice = (lo: number, hi: number): VsItem<number>[] => {
    const out: VsItem<number>[] = [];
    for (let i = Math.max(0, lo); i < Math.min(N, hi); i++) { const it = itemAt(i); if (it) out.push(it); }
    return out;
  };
  let resolver: ((items?: VsItem<number>[]) => void) | null = null;
  let pendingRange = { lo: 0, hi: 0 };
  let gets = 0;
  const src: VsSource<number> = {
    init: async (_r, older) => slice(N - older, N),
    // 普通 function return Promise（不用 async，避免多一层 thenable assimilation microtask 阻塞测试 flush）
    getOlder: function (cursorId: string | number, count: number): Promise<VsItem<number>[]> {
      gets++; const k = num(cursorId); pendingRange = { lo: k - count, hi: k };
      return new Promise(resolve => { resolver = (items?: VsItem<number>[]) => resolve(items ?? slice(pendingRange.lo, pendingRange.hi)); });
    },
    getNewer: async (cursorId, count) => { const k = num(cursorId); return slice(k + 1, k + 1 + count); },
    appendLive: (items) => items.map((it, i) => ({ ...it, id: `live-${i}`, boundary: 'newest' as const })),
    destroy: () => {},
  };
  return Object.assign(src, {
    gets: () => gets,
    resolveOlder: (items?: VsItem<number>[]) => { if (resolver) { const r = resolver; resolver = null; r(items); } },
    isPending: () => resolver !== null,
  });
}

describe('VirtualScrollerAnchor（方案 A · array index）', () => {
  let viewport: HTMLDivElement;
  let content: HTMLDivElement;
  let scroller: VirtualScrollerAnchor<number> | undefined;
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
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const info = scroller.getInfo();
    expect(info.mounted).toBe(100);          // initBatch=100（100×100px=10000 > threshold 6000，不补批）
    expect(info.oldestId).toBe('m-400');      // 这批最老
    expect(info.newestId).toBe('m-499');      // 锚点=最新
    expect(info.atBottom).toBe(true);
  });

  it('方案 A：loadOlder 后 scrollTop【不被内核补偿】（与 B 的关键区别）', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    viewport.scrollTop = 50;
    const stBefore = viewport.scrollTop;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve(); // flush loadOlder
    await Promise.resolve();
    // 方案 A 不补偿：scrollTop 仍为滚到时的值（未被 += 新挂高度）
    expect(viewport.scrollTop).toBe(stBefore);
  });

  it('measurePending 移除挂载元素 vs-pending', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(content.querySelectorAll('.vs-pending').length).toBe(0);
  });

  // ── 阶段0：noOlder absorb 时机（revalidate 通过后才吸收，方案 A 同修）──

  it('阶段0：fling 反向时含 oldest 边界批不挂 → noOlder 不锁死、回顶仍能 getOlder', async () => {
    const { hooks } = controllableHooks();
    const src = controllableSource(120); // init 100 → 第一次 getOlder 返回 m-0..m-19（含 oldest=m-0）
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks, source: src });
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

  // ── 阶段1：骨架 item（vs-ghost，方案 A 同；不补偿 scrollTop）──

  it('阶段1：init 后顶部 mounted[0] 显 vs-ghost（未到最老），且仅一条', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const oldest = scroller.getInfo().oldestId!;
    expect(content.querySelector(`[data-vs-id="${oldest}"]`)?.classList.contains('vs-ghost')).toBe(true);
    expect(content.querySelectorAll('.vs-ghost').length).toBe(1);
  });

  it('阶段1：滚到全局最老（noOlder）→ vs-ghost 消失', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(120) });
    await scroller.init();
    for (let i = 0; i < 6; i++) {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
    }
    expect(scroller.getInfo().noOlder).toBe(true);
    expect(content.querySelectorAll('.vs-ghost').length).toBe(0);
  });

  it('loadOlder 截最新端 → noNewer 重置 false（loadNewer 可加载回，修向下滚/定位底部卡住）', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(scroller.getInfo().noNewer).toBe(true);
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve(); await Promise.resolve();
    expect(scroller.getInfo().noNewer).toBe(false);
  });

  it('destroy 清空挂载', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    scroller.destroy();
    expect(content.children.length).toBe(0);
  });
});
