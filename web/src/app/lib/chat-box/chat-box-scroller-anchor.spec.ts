/**
 * ChatBoxScrollerAnchor（方案 A：借浏览器锚定）单元测试 —— array index-based。
 *
 * 重点验方案 A 与 B 的关键区别：loadOlder（顶部 prepend）/ 上方变化时内核**不写 scrollTop**
 *（交浏览器 overflow-anchor）。mock 环境无浏览器锚定，故断言「scrollTop 未被内核改动」即证明未补偿。
 *
 * mock source 用 msgId 游标（'m-K'，K=0 最老），不再连续抽象 id —— 验证内核 index 与 source id 解耦。
 */
import { ChatBoxScrollerAnchor, VsElement, VsItem } from './chat-box-scroller-anchor';
import type { VsSource } from './source';

/** 'm-K' → K（msgId 解析为序号，供 fakeSource 游标定位）。 */
function num(id: string | number): number { return Number(String(id).replace(/^m-/, '')); }

/** content 子元素 offsetHeight 之和（验 totalH）。 */
function sumChildrenHeight(el: HTMLElement): number {
  let s = 0;
  for (const c of Array.from(el.children)) s += (c as HTMLElement).offsetHeight || 0;
  return s;
}

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
function fakeSource(N: number): VsSource<number> & { gets: () => number; newers: () => number } {
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
  let newers = 0;
  const src: VsSource<number> = {
    init: async (anchorId, older, newer) => {
      if (anchorId === -1) return slice(N - older, N);
      const idx = num(anchorId);
      if (idx < 0 || idx >= N) return [];
      const olderStart = Math.max(0, idx - older + 1);
      const newerEnd = Math.min(N, idx + 1 + newer);
      return [...slice(olderStart, idx + 1), ...slice(idx + 1, newerEnd)];
    },
    getOlder: async (cursorId, count) => { gets++; const k = num(cursorId); return slice(k - count, k); },
    getNewer: async (cursorId, count) => { newers++; const k = num(cursorId); return slice(k + 1, k + 1 + count); },
    appendLive: (items) => items.map((it, i) => ({ ...it, id: `live-${i}`, boundary: 'newest' as const })),
    destroy: () => {},
  };
  return Object.assign(src, { gets: () => gets, newers: () => newers });
}

/** 可控 init 的 source：init 返回手动 resolve 的 Promise（测连续跳转 gen 超越）。 */
function controllableInitSource(N: number): VsSource<number> & {
  resolveInit: (items: VsItem<number>[]) => void; initPending: () => number; batchAround: (k: number) => VsItem<number>[];
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
  const queue: ((items: VsItem<number>[]) => void)[] = [];
  const src: VsSource<number> = {
    init: () => new Promise<VsItem<number>[]>(resolve => { queue.push(resolve); }),
    getOlder: async (c, k) => { const i = num(c); return slice(i - k, i); },
    getNewer: async (c, k) => { const i = num(c); return slice(i + 1, i + 1 + k); },
    appendLive: (items) => items.map((it, i) => ({ ...it, id: `live-${i}`, boundary: 'newest' as const })),
    destroy: () => {},
  };
  return Object.assign(src, {
    resolveInit: (items: VsItem<number>[]) => { const r = queue.shift(); if (r) r(items); },
    initPending: () => queue.length,
    batchAround: (k: number) => [...slice(Math.max(0, k - 49), k + 1), ...slice(k + 1, k + 51)],
  });
}

/** 排空微任务（openAround/fillAround 多跳 async）。 */
async function flush(n = 30): Promise<void> { for (let i = 0; i < n; i++) await Promise.resolve(); }

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
    expect(info.oldestId).toBe('m-400');      // 这批最老
    expect(info.newestId).toBe('m-499');      // 锚点=最新
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

  it('measurePending 移除挂载元素 vs-pending', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(content.querySelectorAll('.vs-pending').length).toBe(0);
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

  // ── 阶段1：骨架 item（vs-ghost，方案 A 同；不补偿 scrollTop）──

  it('阶段1：init 后顶部 mounted[0] 显 vs-ghost（未到最老），且仅一条', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const oldest = scroller.getInfo().oldestId!;
    expect(content.querySelector(`[data-vs-id="${oldest}"]`)?.classList.contains('vs-ghost')).toBe(true);
    expect(content.querySelectorAll('.vs-ghost').length).toBe(1);
  });

  it('阶段1：滚到全局最老（noOlder）→ vs-ghost 消失', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(120) });
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
    scroller.scrollToIndex('m-450', 'top');
    expect(viewport.scrollTop).toBe(5000);
    scroller.scrollToIndex('m-450', 'center');
    expect(viewport.scrollTop).toBe(4750);
    scroller.scrollToIndex('m-450', 'bottom');
    expect(viewport.scrollTop).toBe(4500);
  });

  it('init({startMsgId}) 中段 → 双向窗口围绕目标、居中（无 fill）', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 'm-2500', anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.oldestId).toBe('m-2451');
    expect(info.newestId).toBe('m-2550');
    expect(info.noOlder).toBe(false);
    expect(info.noNewer).toBe(false);
    expect(viewport.scrollTop).toBe(4650);
  });

  it('scrollToIndex 未挂载 → 重置窗口围绕 id（re-seed）、目标挂载并居中', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init();
    scroller.scrollToIndex('m-100', 'center');
    await flush();
    const info = scroller.getInfo();
    expect(info.oldestId).toBe('m-51');
    expect(info.newestId).toBe('m-150');
    expect(viewport.scrollTop).toBe(4650);
  });

  // Regression (mirror of B-kernel): jumping to a NON-HEAD member of a merged album must resolve to its
  // album item via VsItem.ids. Pre-fix the viewport ended up empty (hasTarget false → early return).
  it('scrollToIndex to a non-head album member msgId → resolves to album item, window non-empty (ids member-resolution regression)', async () => {
    const { hooks } = controllableHooks();
    const mergeItems = (items: VsItem<number>[]): VsItem<number>[] => {
      const out: VsItem<number>[] = [];
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
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks: { ...hooks, mergeItems }, source: fakeSource(5000) });
    await scroller.init();
    scroller.scrollToIndex('m-11', 'center'); // non-head album member
    await flush();
    const info = scroller.getInfo();
    expect(info.mounted).toBeGreaterThan(0);
    expect(num(info.oldestId as string)).toBeLessThanOrEqual(10);
    expect(num(info.newestId as string)).toBeGreaterThanOrEqual(12);
    expect(viewport.scrollTop).toBe(750);
  });

  it('近最旧跳转 → noOlder、上方不足 threshold/2 → 下方补偿到 threshold', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 'm-5', anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noOlder).toBe(true);
    expect(info.newestId).toBe('m-105');
    expect(info.noNewer).toBe(false);
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000);
  });

  it('近最新跳转 → noNewer、下方不足 threshold/2 → 上方补偿到 threshold', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 'm-4995', anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noNewer).toBe(true);
    expect(info.oldestId).toBe('m-4896');
    expect(info.noOlder).toBe(false);
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000);
  });

  it('极小会话跳转 → 两侧均到界、totalH<threshold、直接渲染', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(30) });
    await scroller.init({ startMsgId: 'm-15', anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noOlder).toBe(true);
    expect(info.noNewer).toBe(true);
    expect(info.mounted).toBe(30);
  });

  it('短 item 跳转 → fill 循环向两侧补到 threshold/2', async () => {
    const { hooks } = controllableHooks(10);
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 'm-2500', anchor: 'center' });
    expect(scroller.getInfo().mounted).toBeGreaterThan(100);
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000);
  });

  it('scrollToIndex highlight → 目标行加 vs-jump-highlight', async () => {
    const { hooks } = controllableHooks();
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    scroller.scrollToIndex('m-450', 'top', true);
    const el = content.querySelector<HTMLElement>('[data-vs-id="m-450"]');
    expect(el?.classList.contains('vs-jump-highlight')).toBe(true);
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
    const newestBefore = num(scroller.getInfo().newestId!);
    viewport.scrollTop = content.scrollHeight - 600; // 贴底 → loadNewer
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.newers()).toBeGreaterThan(0);
    expect(num(scroller.getInfo().newestId!)).toBeGreaterThan(newestBefore);
  });

  it('openAround：source 返回不含目标的批 → 安全 no-op（不挂载、不崩溃）', async () => {
    const { hooks } = controllableHooks();
    const src: VsSource<number> = {
      init: async () => [{ id: 'other-1', data: 1 }, { id: 'other-2', data: 2 }],
      getOlder: async () => [], getNewer: async () => [],
      appendLive: (items) => items, destroy: () => {},
    };
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    scroller.scrollToIndex('m-target', 'center');
    await flush();
    expect(scroller.getInfo().mounted).toBe(0);
  });

  it('连续两次跳转 → gen 守卫：在途的第一次被丢弃，最终窗口围绕第二次', async () => {
    const { hooks } = controllableHooks();
    const src = controllableInitSource(5000);
    scroller = new ChatBoxScrollerAnchor<number>({ viewport, content, hooks, source: src });
    scroller.scrollToIndex('m-100', 'center'); // openAround#1（gen=1）
    scroller.scrollToIndex('m-200', 'center'); // openAround#2（++gen=2）
    expect(src.initPending()).toBe(2);
    src.resolveInit(src.batchAround(100)); // #1 → gen≠ → 丢弃
    src.resolveInit(src.batchAround(200)); // #2 → 挂 m-151..m-250
    await flush();
    const info = scroller.getInfo();
    expect(info.oldestId).toBe('m-151');
    expect(info.newestId).toBe('m-250');
  });
});
