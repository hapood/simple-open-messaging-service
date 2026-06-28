/**
 * VirtualScroller（相对滚动架构）单元测试。
 *
 * 测试策略：内核框架无关、只通过 VsElement 接口与元素交互，故用 mock VsElement
 * （真实 div + Object.defineProperty 覆盖 offsetHeight）驱动，不依赖 CSS 布局——
 * content.scrollHeight / viewport.clientHeight / scrollTop 均用 getter/setter 固定，
 * 保证断言确定。requestAnimationFrame mock 为同步执行，balance 立即生效。
 */
import { VirtualScroller, VsElement, VsItem, VsDebugStats } from './virtual-scroller';

/** 求元素子节点 offsetHeight 之和（content.scrollHeight 的可控实现）。 */
function sumChildrenHeight(el: HTMLElement): number {
  let s = 0;
  for (const c of Array.from(el.children)) s += (c as HTMLElement).offsetHeight || 0;
  return s;
}

function makeItems(n: number): VsItem<number>[] {
  return Array.from({ length: n }, (_, i) => ({ id: i, data: i }));
}

/**
 * 可控 hooks：每个元素高度可事后改（setHeight 触发 onHeightChange 上报）。
 * offsetHeight 跟随 heights map，使 content.scrollHeight 与内核 heights 缓存一致。
 */
function controllableHooks(itemHeight = 100): {
  hooks: { createItem: (item: VsItem<number>) => VsElement<number> };
  setHeight: (id: number, h: number) => void;
} {
  const cbs = new Map<number, (h: number) => void>();
  const heights = new Map<number, number>();
  const h0 = (id: number) => heights.get(id) ?? itemHeight;
  return {
    hooks: {
      createItem: (item): VsElement<number> => {
        const id = item.id as number;
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
    setHeight: (id: number, h: number) => { heights.set(id, h); cbs.get(id)?.(h); },
  };
}

describe('VirtualScroller (相对滚动)', () => {
  let viewport: HTMLDivElement;
  let content: HTMLDivElement;
  let scroller: VirtualScroller<number> | undefined;
  let rafSpy: jasmine.Spy;
  // ngDevMode 在生产 AOT 被 Angular 置 falsy 并据此删除诊断代码；这里显式管控其真假，
  // 使 spec 不依赖 karma 环境是否注入了该全局。
  let savedNgDev: unknown;

  beforeEach(() => {
    viewport = document.createElement('div');
    content = document.createElement('div');
    viewport.appendChild(content);
    document.body.appendChild(viewport);

    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 600 });
    let st = 0;
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => st, set: v => { st = v; } });
    Object.defineProperty(content, 'scrollHeight', { configurable: true, get: () => sumChildrenHeight(content) });

    // balance 走 RAF 节流，mock 为同步执行。
    rafSpy = spyOn(window, 'requestAnimationFrame').and.callFake((cb: FrameRequestCallback) => { cb(0); return 0; });

    // 默认按 dev 模式跑（ngDevMode truthy），诊断采集开启——与生产 AOT 删除对照。
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

  it('setItems 从顶部挂载首批，直到填满 视口 + buffer', () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(1000));
    const info = scroller.getInfo();
    // 600(视口) + 1800(buffer=3×vh) = 2400；每项 100 → 24 项填满。
    expect(info.mountedStart).toBe(0);
    expect(info.mountedEnd).toBe(24);
    expect(info.atTop).toBe(true);
    expect(info.mounted).toBe(24);
  });

  it('estimateHeight 作为初值：估算小于实测时，首批挂载量按估算偏多', () => {
    // estimateHeight=50（小），实测 offsetHeight=100。mountInitialForward 用 content.scrollHeight
    // （基于 offsetHeight=100）判定停止 → 仍 24 项；但内核 heights 缓存初值是 estimate(50)，
    // onHeightChange 上报 100 后修正。此处验证不报错且挂载合理。
    const cbs = new Map<number, (h: number) => void>();
    const hooks = {
      createItem: (item: VsItem<number>): VsElement<number> => {
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => 100 });
        const id = item.id as number;
        return {
          el,
          estimateHeight: () => 50,
          onHeightChange: (cb) => { cbs.set(id, cb); cb(100); return () => { cbs.delete(id); }; },
          destroy: () => {},
        };
      },
    };
    scroller = new VirtualScroller<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(1000));
    expect(scroller.getInfo().mountedEnd).toBe(24);
  });

  it('scrollToBottom 跳到末尾并贴底', () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(100));
    scroller.scrollToBottom();
    const info = scroller.getInfo();
    expect(info.mountedEnd).toBe(100);
    expect(info.atBottom).toBe(true);
    expect(viewport.scrollTop).toBe(content.scrollHeight - 600);
  });

  it('scrollToBottom 预估偏大且元素极矮时 fillBackward 兜底补满视口（不露白）', () => {
    // estimateHeight=1000（巨高），实测 offsetHeight=10（极矮）。主循环按缓存(1000)挂极少 +
    // bTarget 40 条 = 41×10=410px < 视口 600 → 无兜底会露白；fillBackward 按真实内容高补满。
    const hooks = {
      createItem: (): VsElement<number> => {
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => 10 });
        return { el, estimateHeight: () => 1000, onHeightChange: () => () => {}, destroy: () => {} };
      },
    };
    scroller = new VirtualScroller<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(1000));
    scroller.scrollToBottom();
    expect(content.scrollHeight).toBeGreaterThanOrEqual(600); // 兜底后视口不空
    expect(scroller.getInfo().mountedEnd).toBe(1000);          // 钉底
  });

  it('scrollToIndex 跳到指定 index 并将其纳入挂载窗口（center 锚定）', () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(1000));
    scroller.scrollToIndex(500, 'center');
    const info = scroller.getInfo();
    // 目标 index 落在挂载窗口内（向下填满视口+buffer，向上 bTarget 条 buffer）。
    expect(info.mountedStart).toBeLessThanOrEqual(500);
    expect(info.mountedEnd).toBeGreaterThan(500);
    expect(info.mounted).toBeLessThan(1000); // 虚拟化：未全量挂载
    expect(viewport.scrollTop).toBeGreaterThan(0);
    // center 锚定：目标 item 顶端偏移 = 上方 buffer(40×100) - (vh/2 - h/2) = 4000 - 250。
    expect(viewport.scrollTop).toBe(4000 - (600 / 2 - 100 / 2));
  });

  it('scrollToIndex clamp 越界 index 到 [0, len-1]', () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(1000));
    scroller.scrollToIndex(99999, 'top');
    const info = scroller.getInfo();
    expect(info.mountedEnd).toBe(1000);   // 越界→末条，向下无可挂
    expect(info.atBottom).toBe(true);
  });

  it('append 在贴底时跟随滚动到新底部', () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(50));
    scroller.scrollToBottom();
    expect(scroller.getInfo().atBottom).toBe(true);

    scroller.appendItems(makeItems(3));
    const info = scroller.getInfo();
    expect(info.atBottom).toBe(true);
    expect(info.mountedEnd).toBe(53);
    expect(info.total).toBe(53);
  });

  it('append 在未贴底时不主动挂载（等用户滚下）', () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(50)); // scrollTop=0，未贴底
    const endBefore = scroller.getInfo().mountedEnd;
    scroller.appendItems(makeItems(3));
    // 未贴底：不主动挂新元素，mountedEnd 不变（total 增加）
    expect(scroller.getInfo().mountedEnd).toBe(endBefore);
    expect(scroller.getInfo().total).toBe(53);
  });

  it('prepend 平移已挂载索引并锚点补偿 scrollTop（视觉不跳）', () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(100));
    scroller.scrollToBottom();
    const stBefore = viewport.scrollTop;
    const startBefore = scroller.getInfo().mountedStart;
    const endBefore = scroller.getInfo().mountedEnd;

    scroller.prependItems(makeItems(5));
    // 5 条历史插到顶部：索引整体 +5；scrollTop += 5*100（锚点补偿）。
    expect(scroller.getInfo().mountedStart).toBe(startBefore + 5);
    expect(scroller.getInfo().mountedEnd).toBe(endBefore + 5);
    expect(viewport.scrollTop).toBe(stBefore + 5 * 100);
  });

  it('prepend 不重渲原首条（边界重渲已移除，依赖宿主幽灵保证分组不变）', () => {
    let total = 0;
    const hooks = {
      createItem: (): VsElement<number> => {
        total++;
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => 100 });
        return { el, estimateHeight: () => 100, onHeightChange: () => () => {}, destroy: () => {} };
      },
    };
    scroller = new VirtualScroller<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(100));
    scroller.scrollToBottom();
    const before = total;
    scroller.prependItems(makeItems(5));
    // 仅挂载新批次 5 条；原首条不再重 mount（旧实现会 +1 重渲）
    expect(total).toBe(before + 5);
  });

  it('视口高于初始内容时，scrollToBottom 触发多次 onLoadMore 补满首屏（ensureFilled）', () => {
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 4000 });
    let calls = 0;
    const onLoadMore = (): VsItem<number>[] | null => {
      calls++;
      if (calls > 20) return null;   // 安全封顶（模拟尽头）
      return makeItems(5);           // 每批 5 条 × 100px = 500px
    };
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, onLoadMore });
    scroller.setItems(makeItems(5)); // 初始 5 条 = 500px ≪ 4000px 视口
    calls = 0;                       // setItems 不触发 ensureFilled
    scroller.scrollToBottom();
    // 初始 500px，每批 +500px → 约 7 批填满 4000px
    expect(calls).toBeGreaterThanOrEqual(7);
    expect(content.scrollHeight).toBeGreaterThanOrEqual(4000);
  });

  it('视口上方元素高度变化 → scrollTop 锚点补偿', () => {
    const { hooks, setHeight } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(100));
    scroller.scrollToBottom(); // 贴底；item 90 在挂载窗口内、视口上方
    // stub scheduleBalance：隔离 balance 窗口调整对 scrollTop 的副作用，只验 onElHeight 补偿本身。
    spyOn(scroller as unknown as { scheduleBalance: () => void }, 'scheduleBalance').and.stub();
    const st = viewport.scrollTop;
    expect(scroller.getInfo().mountedStart).toBeLessThanOrEqual(90); // item90 已挂载

    setHeight(90, 150); // item90: 100 → 150
    expect(viewport.scrollTop).toBe(st + 50); // 视口上方 +50 → scrollTop += 50
  });

  it('视口下方元素高度变化不补偿 scrollTop', () => {
    const { hooks, setHeight } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(100));
    scroller.scrollToBottom();
    spyOn(scroller as unknown as { scheduleBalance: () => void }, 'scheduleBalance').and.stub();
    const st = viewport.scrollTop;
    const last = scroller.getInfo().mountedEnd - 1; // 末尾元素，在视口下方/内

    setHeight(last, 150);
    expect(viewport.scrollTop).toBe(st); // 下方变化不补偿
  });

  it('滚动后双向回收：挂载窗口跟随视口，不全量挂载', () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(500));
    scroller.scrollToBottom();

    // 向上滚一段，触发 balance（scroll 事件 → RAF → balance）。
    viewport.scrollTop = Math.max(0, viewport.scrollTop - 3000);
    viewport.dispatchEvent(new Event('scroll'));

    const info = scroller.getInfo();
    expect(info.mounted).toBeLessThan(500); // 虚拟化：未全量挂载
    expect(info.mountedEnd).toBeGreaterThan(info.mountedStart); // 窗口非空
  });

  it('destroy 清理：卸载全部元素', () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(100));
    expect(scroller.getInfo().mounted).toBeGreaterThan(0);
    scroller.destroy();
    // destroy 后 content 无挂载元素（content 仅含挂载的 item div）
    expect(content.children.length).toBe(0);
  });

  it('dev(ngDevMode truthy) 下 balance 通过 onDebug 上报单帧诊断', () => {
    const stats: VsDebugStats[] = [];
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, onDebug: s => stats.push(s) });
    scroller.setItems(makeItems(500));
    scroller.scrollToBottom(); // 直挂载、不经 balance
    expect(stats.length).toBe(0);

    // 向上滚 → balance 挂载更早 item + 回收底部 → onDebug 上报
    viewport.scrollTop = Math.max(0, viewport.scrollTop - 3000);
    viewport.dispatchEvent(new Event('scroll'));
    expect(stats.length).toBeGreaterThan(0);
    expect(stats[0].mount + stats[0].unmount).toBeGreaterThan(0);
  });

  it('生产(ngDevMode falsy) 下 balance 不触发诊断——AOT 可删除的语义保证', () => {
    (globalThis as { ngDevMode?: unknown }).ngDevMode = false; // 模拟生产 AOT：诊断分支不可达
    let called = 0;
    const { hooks } = controllableHooks();
    scroller = new VirtualScroller<number>({ viewport, content, hooks, onDebug: () => called++ });
    scroller.setItems(makeItems(500));
    scroller.scrollToBottom();
    viewport.scrollTop = Math.max(0, viewport.scrollTop - 3000);
    viewport.dispatchEvent(new Event('scroll'));
    expect(called).toBe(0); // 诊断回调零调用（afterEach 恢复 ngDevMode 原值）
  });
});
