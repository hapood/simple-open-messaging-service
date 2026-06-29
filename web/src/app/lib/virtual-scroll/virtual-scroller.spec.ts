/**
 * VirtualScroller（方案 B · array index）单元测试。
 *
 * 内核框架无关、只通过 VsElement + VsSource 接口交互，故用 mock 驱动：
 *  - controllableHooks：真 div + Object.defineProperty(offsetHeight)，createItem(item, prev)。
 *  - fakeSource：N 条 msg（'m-0'最老 .. 'm-(N-1)'最新），游标 getOlder/getNewer，升序返回。
 * content.scrollHeight / viewport.clientHeight / scrollTop 用 getter/setter 固定；RAF mock 同步。
 *
 * 重点：方案 B 的 scrollTop 补偿（loadOlder prepend 后视口不跳）、ghost rebuild（以新 prev 再 createItem）、
 *  阶段0 noOlder absorb 时机。msgId 游标验证内核 index 与 source id 解耦。
 */
import { VirtualScroller, VsElement, VsItem } from './virtual-scroller';
import type { VsSource } from './source';

/** 'm-K' → K（msgId 解析为序号）。 */
function num(id: string | number): number { return Number(String(id).replace(/^m-/, '')); }

function sumChildrenHeight(el: HTMLElement): number {
  let s = 0;
  for (const c of Array.from(el.children)) s += (c as HTMLElement).offsetHeight || 0;
  return s;
}

/** 可控 hooks：createItem(item, prev)，每项高度固定（可事后 setHeight 改）。用 msgId 当 Map key。 */
function controllableHooks(itemHeight = 100): {
  hooks: { createItem: (item: VsItem<number>, prev: VsItem<number> | null) => VsElement<number> };
  setHeight: (id: string, h: number) => void;
} {
  const cbs = new Map<string, (h: number) => void>();
  const heights = new Map<string, number>();
  const h0 = (id: string) => heights.get(id) ?? itemHeight;
  return {
    hooks: {
      createItem: (item): VsElement<number> => {
        const id = String(item.id);
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => h0(id) });
        return {
          el,
          estimateHeight: () => itemHeight,
          onHeightChange: (cb) => { cbs.set(id, cb); return () => { cbs.delete(id); }; },
          destroy: () => {},
        };
      },
    },
    setHeight: (id: string, h: number) => { heights.set(id, h); cbs.get(id)?.(h); },
  };
}

/** 记录每次 createItem 的 (id, prev.id) 的 hooks——验 ghost rebuild 以新 prev 再调。 */
function recordingHooks(itemHeight = 100): {
  hooks: { createItem: (item: VsItem<number>, prev: VsItem<number> | null) => VsElement<number> };
  calls: { id: string; prev: string | null }[];
} {
  const calls: { id: string; prev: string | null }[] = [];
  return {
    hooks: {
      createItem: (item, prev): VsElement<number> => {
        const id = String(item.id);
        calls.push({ id, prev: prev ? String(prev.id) : null });
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => itemHeight });
        return { el, estimateHeight: () => itemHeight, onHeightChange: () => () => {}, destroy: () => {} };
      },
    },
    calls,
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
      if (anchorId === -1) return slice(N - older, N); // 锚点=最新
      const idx = num(anchorId); // 真实 msgId：双向取（镜像 MockItemSource）
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

/** 可控 init 的 source：init 返回手动 resolve 的 Promise（测连续跳转 gen 超越：在途跳转被丢弃）。 */
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

/** 排空微任务（openAround/fillAround 的多跳 async await）：scrollToIndex 是 fire-and-forget，需手动 flush。 */
async function flush(n = 30): Promise<void> { for (let i = 0; i < n; i++) await Promise.resolve(); }

describe('VirtualScroller（方案 B · array index）', () => {
  let viewport: HTMLDivElement;
  let content: HTMLDivElement;
  let scroller: VirtualScroller<number> | undefined;
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

  it('init 取最新一批、贴底、窗口边界 msgId 正确', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const info = scroller.getInfo();
    expect(info.mounted).toBe(100);
    expect(info.oldestId).toBe('m-400');
    expect(info.newestId).toBe('m-499');
    expect(info.atBottom).toBe(true);
    expect(info.noNewer).toBe(true);  // boundary newest 已吸收（锚点）
    expect(info.noOlder).toBe(false); // 未到最老
  });

  it('上滑到顶边缘 → loadOlder 触发 getOlder、挂更老、oldestId 变更老', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    const oldestBefore = scroller.getInfo().oldestId!;
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    await Promise.resolve();
    expect(src.gets()).toBeGreaterThan(0);
    // 挂了更老：oldestId 序号变小（更老）；trim 后窗口滚走，oldestId 可能变更老
    expect(num(scroller.getInfo().oldestId!)).toBeLessThanOrEqual(num(oldestBefore));
  });

  it('方案 B：loadOlder 后 scrollTop 补偿（视口不跳）', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    viewport.scrollTop = 50;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    await Promise.resolve();
    // loadOlder prepend 在视口上方 → scrollTop 应被 += 新挂高度（>50，非 0）
    expect(viewport.scrollTop).toBeGreaterThan(50);
  });

  it('到最老边界后继续上滑 → 不再 getOlder（noOlder 熔断）', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(120); // 仅 120 条，init 100 + 一次补批即到最老
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: src });
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

  it('appendLive（WS）挂到底部、贴底跟随', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    scroller.appendLive([{ id: 'x', data: -1 }]);
    await Promise.resolve();
    const info = scroller.getInfo();
    expect(info.newestId).toBe('live-0');
    expect(info.atBottom).toBe(true);
  });

  it('trim：连续 loadOlder 窗口稳定不无限增长（保留视口 buffer）', async () => {
    const { hooks } = controllableHooks(); // 100px/项
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init();
    const totals: number[] = [];
    for (let i = 0; i < 10; i++) {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event('scroll'));
      await Promise.resolve(); await Promise.resolve();
      if (i >= 5) totals.push(sumChildrenHeight(content));
    }
    // trim 保留视口 buffer（loadOlder 的 compensateAbove 推大 st → total ~ st+vh+edge，> threshold 6000，
    //  不是「刚过 threshold」）。验证核心目标：连续 loadOlder 稳定、不无限增长（末次 < threshold*3，后 5 次波动 < 500）。
    expect(totals[totals.length - 1]).toBeLessThan(6000 * 3);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThan(500);
  });

  it('measurePending 移除挂载元素 vs-pending', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(content.querySelectorAll('.vs-pending').length).toBe(0);
  });

  // ── 阶段0：noOlder absorb 时机（revalidate 通过后才吸收，防 fling 回滑误锁）──

  it('阶段0：fling 反向时含 oldest 边界批不挂 → noOlder 不锁死、回顶仍能 getOlder', async () => {
    const { hooks } = controllableHooks();
    const src = controllableSource(120); // init 100 → 第一次 getOlder 返回 m-0..m-19（含 oldest=m-0）
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init();
    expect(scroller.getInfo().noOlder).toBe(false);

    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    expect(src.isPending()).toBe(true);

    // fling 反向：离开顶边缘（>edge=1000）+ scrollDir 变 down
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

  // ── 阶段1：骨架 item（vs-ghost + rebuild）──

  it('阶段1：init 后顶部 mounted[0] 显 vs-ghost（未到最老），且仅一条', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const oldest = scroller.getInfo().oldestId!;
    expect(content.querySelector(`[data-vs-id="${oldest}"]`)?.classList.contains('vs-ghost')).toBe(true);
    expect(content.querySelectorAll('.vs-ghost').length).toBe(1);
  });

  it('阶段1：滚到全局最老（noOlder）→ vs-ghost 消失', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(120) });
    await scroller.init();
    for (let i = 0; i < 6; i++) {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event('scroll'));
      await Promise.resolve(); await Promise.resolve();
    }
    expect(scroller.getInfo().noOlder).toBe(true);
    expect(content.querySelectorAll('.vs-ghost').length).toBe(0);
  });

  it('阶段1：loadOlder 挂更老邻居 → 旧 ghost rebuild（createItem 以新 prev 再调）', async () => {
    const { hooks, calls } = recordingHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    const ghostId = scroller.getInfo().oldestId!; // 'm-400'：挂载时 prev=null（顶部）
    expect(calls.filter(c => c.id === ghostId)[0].prev).toBeNull();

    // 上滑触发 loadOlder（挂更老 m-300..m-399）：ghostId 获得更老邻居 → rebuild
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve(); await Promise.resolve();

    const forGhost = calls.filter(c => c.id === ghostId);
    expect(forGhost.length).toBe(2);          // 挂载 + rebuild
    expect(forGhost[1].prev).not.toBeNull();   // 新 prev = 更老邻居
  });

  it('loadOlder 截最新端 → noNewer 重置 false（loadNewer 可加载回，修向下滚/定位底部卡住）', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(scroller.getInfo().noNewer).toBe(true); // init 贴底=全局最新
    // 向上滚 loadOlder：prepend 更老 + trimNewer 截最新端（含全局最新 m-499）
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve(); await Promise.resolve();
    expect(scroller.getInfo().noNewer).toBe(false); // trimNewer 重置 → loadNewer 可加载回
  });

  it('destroy 清空所有挂载元素', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(content.children.length).toBeGreaterThan(0);
    scroller.destroy();
    expect(content.children.length).toBe(0);
  });

  // ── 跳转到指定 id（scrollToIndex / init({startMsgId})）：已挂载定位 + 未挂载 re-seed + 居中填充/边界补偿 ──

  it('scrollToIndex 已挂载 → 按 anchor 定位（top/center/bottom）', async () => {
    const { hooks } = controllableHooks(); // 100px/项
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init(); // 挂 m-400..m-499
    scroller.scrollToIndex('m-450', 'top');     // m-450 index=50 → prefix[50]=5000
    expect(viewport.scrollTop).toBe(5000);
    scroller.scrollToIndex('m-450', 'center');  // 5000 + 50 - 300
    expect(viewport.scrollTop).toBe(4750);
    scroller.scrollToIndex('m-450', 'bottom');  // 5000 + 100 - 600
    expect(viewport.scrollTop).toBe(4500);
  });

  it('init({startMsgId}) 中段 → 双向窗口围绕目标、居中、两侧均足 threshold/2（无 fill）', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 'm-2500', anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.oldestId).toBe('m-2451'); // older 50（m-2451..m-2500，含目标）
    expect(info.newestId).toBe('m-2550'); // newer 50（m-2501..m-2550）
    expect(info.noOlder).toBe(false);
    expect(info.noNewer).toBe(false);
    expect(viewport.scrollTop).toBe(4650); // m-2500 index=49 居中：4900+50-300
  });

  it('scrollToIndex 未挂载 → 重置窗口围绕 id（re-seed）、目标挂载并居中', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init(); // 挂 m-4900..m-4999
    expect(scroller.getInfo().oldestId).toBe('m-4900');
    scroller.scrollToIndex('m-100', 'center'); // 未挂载 → 异步 re-seed
    await flush();
    const info = scroller.getInfo();
    expect(info.oldestId).toBe('m-51');
    expect(info.newestId).toBe('m-150');
    expect(viewport.scrollTop).toBe(4650); // m-100 index=49 居中
  });

  it('近最旧跳转 → noOlder、上方不足 threshold/2 → 下方补偿到 threshold', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 'm-5', anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noOlder).toBe(true);
    expect(info.oldestId).toBe('m-0');
    expect(info.noNewer).toBe(false);
    expect(info.newestId).toBe('m-105'); // seed newer 50（m-6..m-55）+ 补偿 50（m-56..m-105）
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000);
  });

  it('近最新跳转 → noNewer、下方不足 threshold/2 → 上方补偿到 threshold', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 'm-4995', anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noNewer).toBe(true);
    expect(info.newestId).toBe('m-4999');
    expect(info.noOlder).toBe(false);
    expect(info.oldestId).toBe('m-4896'); // 上方补偿 50
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000);
  });

  it('极小会话跳转 → 两侧均到界、totalH<threshold、无法补偿直接渲染', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(30) });
    await scroller.init({ startMsgId: 'm-15', anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.noOlder).toBe(true);
    expect(info.noNewer).toBe(true);
    expect(info.oldestId).toBe('m-0');
    expect(info.newestId).toBe('m-29');
    expect(info.mounted).toBe(30);
    expect(sumChildrenHeight(content)).toBeLessThan(6000); // 不足 threshold、两侧到界无法补
  });

  it('短 item 跳转 → fill 循环向两侧补到 threshold/2（不无限增长）', async () => {
    const { hooks } = controllableHooks(10); // 10px/项 → seed 100 项仅 1000px<3000，需 fill
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(5000) });
    await scroller.init({ startMsgId: 'm-2500', anchor: 'center' });
    const info = scroller.getInfo();
    expect(info.mounted).toBeGreaterThan(100);          // fill 触发
    expect(sumChildrenHeight(content)).toBeGreaterThanOrEqual(6000); // 补到 threshold
    expect(content.querySelector('[data-vs-id="m-2500"]')).toBeTruthy(); // 目标仍在窗口
  });

  it('scrollToIndex highlight → 目标行加 vs-jump-highlight', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    scroller.scrollToIndex('m-450', 'top', true);
    const el = content.querySelector<HTMLElement>('[data-vs-id="m-450"]');
    expect(el?.classList.contains('vs-jump-highlight')).toBe(true);
  });

  // ── 补覆盖：scrollToTop / refresh / loadNewer（向下加载）/ openAround 边界 / gen 超越 ──

  it('scrollToTop → scrollTop=0', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(viewport.scrollTop).toBeGreaterThan(0); // init 贴底
    scroller.scrollToTop();
    expect(viewport.scrollTop).toBe(0);
  });

  it('refresh → 重测 vh + balance，不抛错、窗口仍可用', async () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: fakeSource(500) });
    await scroller.init();
    expect(() => scroller!.refresh()).not.toThrow();
    // 仍可定位（内核未坏）
    scroller.scrollToIndex(scroller.getInfo().newestId!, 'top');
    expect(viewport.scrollTop).toBeGreaterThanOrEqual(0);
  });

  it('向下滚到底边缘 → loadNewer 触发 getNewer、挂更新、newestId 向最新推进', async () => {
    const { hooks } = controllableHooks();
    const src = fakeSource(500);
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: src });
    await scroller.init(); // m-400..m-499 贴底、noNewer=true
    // 向上滚：loadOlder → trimNewer 截最新端 → noNewer=false（loadNewer 解禁）
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(scroller.getInfo().noNewer).toBe(false);
    // 向下滚到底边缘 → loadNewer
    const newestBefore = num(scroller.getInfo().newestId!);
    viewport.scrollTop = content.scrollHeight - 600; // 贴底
    viewport.dispatchEvent(new Event('scroll'));
    await flush();
    expect(src.newers()).toBeGreaterThan(0);                       // getNewer 被调（loadNewer 路径）
    expect(num(scroller.getInfo().newestId!)).toBeGreaterThan(newestBefore); // 向最新推进
  });

  it('openAround：source 返回不含目标的批 → 安全 no-op（不挂载、不崩溃）', async () => {
    const { hooks } = controllableHooks();
    const src: VsSource<number> = {
      init: async () => [{ id: 'other-1', data: 1 }, { id: 'other-2', data: 2 }], // 不含目标
      getOlder: async () => [], getNewer: async () => [],
      appendLive: (items) => items, destroy: () => {},
    };
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: src });
    scroller.scrollToIndex('m-target', 'center');
    await flush();
    expect(scroller.getInfo().mounted).toBe(0); // !hasTarget 早退，未挂载
  });

  it('连续两次跳转 → gen 守卫：在途的第一次被丢弃，最终窗口围绕第二次', async () => {
    const { hooks } = controllableHooks();
    const src = controllableInitSource(5000);
    scroller = new VirtualScroller<number>({ viewport, content, hooks, source: src });
    scroller.scrollToIndex('m-100', 'center'); // openAround#1：init pending（gen=1）
    scroller.scrollToIndex('m-200', 'center'); // openAround#2：++gen=2、reset、init pending
    expect(src.initPending()).toBe(2);
    src.resolveInit(src.batchAround(100)); // #1 resolve → gen(1)≠2 → 丢弃
    src.resolveInit(src.batchAround(200)); // #2 resolve → 挂 m-151..m-250
    await flush();
    const info = scroller.getInfo();
    expect(info.oldestId).toBe('m-151'); // 围绕 m-200，非 m-100
    expect(info.newestId).toBe('m-250');
  });
});
