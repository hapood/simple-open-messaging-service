/**
 * VirtualScrollerAnchor（方案 A：借浏览器锚定）单元测试。
 *
 * 重点验方案 A 与 B 的关键区别：顶部增删 / 上方变高时内核**不写 scrollTop**（交浏览器 overflow-anchor）。
 * mock 环境无浏览器锚定，故断言「scrollTop 未被内核改动」即证明未补偿（真实浏览器里由锚定顶住首个可见元素）。
 */
import { VirtualScrollerAnchor, VsDebugStats, VsElement, VsItem } from './virtual-scroller-anchor';

function sumChildrenHeight(el: HTMLElement): number {
  let s = 0;
  for (const c of Array.from(el.children)) s += (c as HTMLElement).offsetHeight || 0;
  return s;
}
function makeItems(n: number): VsItem<number>[] {
  return Array.from({ length: n }, (_, i) => ({ id: i, data: i }));
}
function controllableHooks(itemHeight = 100): { hooks: { createItem: (item: VsItem<number>) => VsElement<number> } } {
  return {
    hooks: {
      createItem: (item): VsElement<number> => {
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => itemHeight });
        return {
          el,
          estimateHeight: () => itemHeight,
          onHeightChange: () => () => {},
          destroy: () => {},
        };
      },
    },
  };
}

describe('VirtualScrollerAnchor (方案 A · 借浏览器锚定)', () => {
  let viewport: HTMLDivElement;
  let content: HTMLDivElement;
  let scroller: VirtualScrollerAnchor<number> | undefined;
  let rafSpy: jasmine.Spy;
  // ngDevMode 在生产 AOT 被 Angular 置 falsy 并据此删除诊断代码；这里显式管控其真假，
  // 使 spec 不依赖 karma 环境是否注入了该全局（与 B spec 对齐）。
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

  it('setItems 从顶部挂载首批（与 B 同：mountInitialForward 用 scrollHeight 判定）', () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(1000));
    const info = scroller.getInfo();
    expect(info.mountedStart).toBe(0);
    expect(info.mountedEnd).toBe(24); // (600 视口 + 1800 buffer=3×vh) / 100 = 24
  });

  it('scrollToBottom 跳到末尾并贴底（程序化 scrollTop=max，非补偿）', () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(100));
    scroller.scrollToBottom();
    const info = scroller.getInfo();
    expect(info.mountedEnd).toBe(100);
    expect(info.atBottom).toBe(true);
    expect(viewport.scrollTop).toBe(content.scrollHeight - 600);
  });

  it('scrollToBottom 预估偏大且元素极矮时 fillBackward 兜底补满视口（与 B 同构）', () => {
    // estimateHeight=1000、实测 10：主循环按缓存挂 3 条=30px < 视口 600 → 无兜底露白；fillBackward 补满。
    const hooks = {
      createItem: (): VsElement<number> => {
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => 10 });
        return { el, estimateHeight: () => 1000, onHeightChange: () => () => {}, destroy: () => {} };
      },
    };
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(1000));
    scroller.scrollToBottom();
    expect(content.scrollHeight).toBeGreaterThanOrEqual(600);
    expect(scroller.getInfo().mountedEnd).toBe(1000);
  });

  it('scrollToIndex 跳到指定 index 并将其纳入挂载窗口（与 B 同构，程序化写 scrollTop）', () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(1000));
    scroller.scrollToIndex(500, 'center');
    const info = scroller.getInfo();
    expect(info.mountedStart).toBeLessThanOrEqual(500);
    expect(info.mountedEnd).toBeGreaterThan(500);
    expect(info.mounted).toBeLessThan(1000);
    expect(viewport.scrollTop).toBe(4000 - (600 / 2 - 100 / 2)); // 上方 buffer 4000 - center 偏移 250
  });

  it('prepend 平移索引但【不补偿 scrollTop】（A 与 B 的关键区别：B 会 +500）', () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(100));
    scroller.scrollToBottom();
    const st = viewport.scrollTop;
    const startBefore = scroller.getInfo().mountedStart;

    scroller.prependItems(makeItems(5));
    expect(scroller.getInfo().mountedStart).toBe(startBefore + 5); // 索引平移 +5
    expect(viewport.scrollTop).toBe(st); // 不补偿；真实浏览器由 overflow-anchor 顶住
  });

  it('向上滚触发顶部挂载但【内核不写 scrollTop】（交浏览器锚定）', () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(500));
    scroller.scrollToBottom();
    const startBefore = scroller.getInfo().mountedStart;
    const target = Math.max(0, viewport.scrollTop - 3000);
    viewport.scrollTop = target;
    viewport.dispatchEvent(new Event('scroll'));

    expect(scroller.getInfo().mountedStart).toBeLessThan(startBefore); // 确实挂载了更早 item
    expect(viewport.scrollTop).toBe(target); // 内核未补偿（mock 无浏览器锚定）
  });

  it('destroy 清理：卸载全部元素', () => {
    const { hooks } = controllableHooks();
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks });
    scroller.setItems(makeItems(100));
    expect(scroller.getInfo().mounted).toBeGreaterThan(0);
    scroller.destroy();
    expect(content.children.length).toBe(0);
  });

  it('dev(ngDevMode truthy) 下 balance 通过 onDebug 上报单帧诊断', () => {
    const stats: VsDebugStats[] = [];
    const { hooks } = controllableHooks();
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks, onDebug: s => stats.push(s) });
    scroller.setItems(makeItems(500));
    scroller.scrollToBottom();
    expect(stats.length).toBe(0);
    viewport.scrollTop = Math.max(0, viewport.scrollTop - 3000);
    viewport.dispatchEvent(new Event('scroll'));
    expect(stats.length).toBeGreaterThan(0);
    expect(stats[0].mount + stats[0].unmount).toBeGreaterThan(0);
  });

  it('生产(ngDevMode falsy) 下 balance 不触发诊断——AOT 可删除的语义保证', () => {
    (globalThis as { ngDevMode?: unknown }).ngDevMode = false;
    let called = 0;
    const { hooks } = controllableHooks();
    scroller = new VirtualScrollerAnchor<number>({ viewport, content, hooks, onDebug: () => called++ });
    scroller.setItems(makeItems(500));
    scroller.scrollToBottom();
    viewport.scrollTop = Math.max(0, viewport.scrollTop - 3000);
    viewport.dispatchEvent(new Event('scroll'));
    expect(called).toBe(0);
  });
});
