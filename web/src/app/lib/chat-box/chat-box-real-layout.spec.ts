import { NEVER } from 'rxjs';
import type { CbSource } from './cb-source';
import { ChatBoxScroller, type CbItem } from './chat-box-scroller';

/** Chromium integration: every dimension and scroll clamp comes from browser layout. */
describe('chat-box real browser layout', () => {
  let viewport: HTMLDivElement;
  let content: HTMLDivElement;
  let styles: HTMLStyleElement;
  let scroller: ChatBoxScroller<number> | undefined;
  let frames: Map<number, FrameRequestCallback>;
  let now: number;
  let nextFrame: number;
  let browserRaf: typeof requestAnimationFrame;

  function step(ms = 16): void {
    now += ms;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  }

  function settleMotion(): void {
    for (let i = 0; i < 500 && frames.size; i++) step();
    expect(frames.size, 'motion must reach a finite resting position').toBe(0);
  }

  // Native frames let Chromium deliver real scroll events and ResizeObservers.
  // The second frame runs after the preceding frame's observer delivery.
  async function deliverBrowserLayout(): Promise<void> {
    await new Promise<void>((resolve) => {
      browserRaf(() => browserRaf(() => resolve()));
    });
  }

  function row(id: number): HTMLElement {
    const element = content.querySelector<HTMLElement>(`[data-row="${id}"]`);
    expect(element, `row ${id} must be mounted`).not.toBeNull();
    return element!;
  }

  function paintedTop(id: number): number {
    return (
      row(id).getBoundingClientRect().top - viewport.getBoundingClientRect().top
    );
  }

  function translation(): number {
    return new DOMMatrixReadOnly(getComputedStyle(content).transform).m42;
  }

  function expectModelMatchesDOM(): void {
    scroller!.visitMountedGeometry((geometry) => {
      expect(geometry.height).toBe(geometry.el.offsetHeight);
      expect(geometry.top).toBeCloseTo(paintedTop(geometry.item.id), 3);
      expect(geometry.bottom).toBeCloseTo(
        paintedTop(geometry.item.id) + geometry.el.offsetHeight,
        3,
      );
    });
  }

  async function mount(count = 12): Promise<void> {
    const rows: CbItem<number>[] = Array.from({ length: count }, (_, id) => ({
      id,
      data: 100,
      ...(id === 0 ? { boundary: 'oldest' as const } : {}),
      ...(id === count - 1 ? { boundary: 'newest' as const } : {}),
    }));
    const source: CbSource<number> = {
      loadWindow: async () => rows,
      requestOlder: () => NEVER,
      requestNewer: () => NEVER,
      requestMessagesForEmptyWindow: () => NEVER,
      pushLive: () => {},
      destroy: () => {},
    };
    scroller = new ChatBoxScroller({
      viewport,
      content,
      config: { thresholdFloor: 20000, initBatch: count },
      hooks: {
        createItem: (item) => {
          const el = document.createElement('div');
          el.className = 'real-layout-row';
          el.dataset['row'] = String(item.id);
          el.style.height = `${item.data}px`;
          return {
            el,
            update: (next) => {
              el.style.height = `${next.data}px`;
            },
            predestory: () => {},
            destroy: () => {},
          };
        },
      },
    });
    scroller.bind(source);
    await scroller.openWindow({ kind: 'latest' });
    settleMotion();
    await deliverBrowserLayout();
    // Opening an overflowing window may itself introduce a scrollbar and resize.
    vi.advanceTimersByTime(200);
    settleMotion();
    await deliverBrowserLayout();
    expect(viewport.clientHeight).toBe(600);
    expect(viewport.offsetWidth).toBe(500);
    expect(scroller.getInfo().mounted).toBe(count);
    expect(content.offsetHeight).toBe(Math.max(600, count * 100));
    expect(viewport.scrollTop).toBe(Math.max(0, count * 100 - 600));
    expectModelMatchesDOM();
  }

  beforeEach(() => {
    now = 0;
    nextFrame = 0;
    frames = new Map();
    browserRaf = window.requestAnimationFrame.bind(window);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
      const result = matchMedia(query);
      if (query === '(prefers-reduced-motion: reduce)') {
        Object.defineProperty(result, 'matches', { value: false });
      }
      return result;
    });
    styles = document.createElement('style');
    // Reproduce the production flex-end content, pending and reserve contracts.
    // The default hidden scrollbar mirrors the message viewport; separate cases
    // enable a non-overlay scrollbar to exercise the generic scroller's gutter.
    styles.textContent = `
      .real-layout-viewport {
        position: fixed;
        top: 0;
        left: 0;
        width: 500px;
        height: 600px;
        padding: 0;
        border: 0;
        overflow-x: hidden;
        overflow-y: auto;
        overflow-anchor: none;
        scroll-behavior: auto;
        scrollbar-width: none;
        --soms-content-bottom-reserve: 0px;
      }
      .real-layout-viewport.with-scrollbar { scrollbar-width: auto; }
      .real-layout-viewport.with-scrollbar::-webkit-scrollbar {
        display: block;
        width: 16px;
      }
      .real-layout-viewport .cb-list {
        position: relative;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        min-height: 100%;
        margin: 0;
        padding: 0;
        border: 0;
      }
      .real-layout-viewport .cb-list > * { flex-shrink: 0; }
      .real-layout-row { box-sizing: border-box; line-height: 20px; }
      .real-layout-viewport .cb-pending { visibility: hidden !important; }
      .real-layout-viewport .cb-bottom-reserve {
        box-sizing: border-box;
        height: var(--soms-content-bottom-reserve, 0px);
        flex-shrink: 0;
      }
    `;
    document.head.append(styles);
    viewport = document.createElement('div');
    viewport.className = 'real-layout-viewport';
    content = document.createElement('div');
    content.className = 'cb-list';
    viewport.append(content);
    document.body.append(viewport);
  });

  afterEach(() => {
    scroller?.destroy();
    scroller = undefined;
    viewport.remove();
    styles.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('warns about height drift without per-row paint or CSS diagnostics', async () => {
    await mount();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rectReads = Array.from({ length: 12 }, (_, id) => {
      row(id).style.height = '100.4px';
      return vi.spyOn(row(id), 'getBoundingClientRect');
    });
    const computedStyles = vi.spyOn(window, 'getComputedStyle');
    scroller!.mutateItem(0, (item) => ({ ...item }));
    expect(warning).toHaveBeenCalledWith('[vs.measure] height model drift', {
      model: 1200,
      dom: content.scrollHeight,
      delta: 1200 - content.scrollHeight,
      viewport: 600,
      count: 12,
    });
    for (const read of rectReads) expect(read).not.toHaveBeenCalled();
    expect(computedStyles).not.toHaveBeenCalled();
  });

  it('keeps normal DPR-1 motion interruptible despite rounded native scrollTop', async () => {
    expect(window.devicePixelRatio).toBe(1);
    await mount();
    viewport.scrollTop = 100;
    await scroller!.goToLatest();
    step();
    expect(viewport.scrollTop).toBe(101);
    expect(translation()).toBeCloseTo(-0.152, 3);
    expect(getComputedStyle(viewport).overflowY).toBe('auto');
    await deliverBrowserLayout();
    step();
    expect(viewport.scrollTop).toBeGreaterThan(101);
    const wheel = new WheelEvent('wheel', { deltaY: -20, cancelable: true });
    viewport.dispatchEvent(wheel);
    const stopped = viewport.scrollTop;
    expect(wheel.defaultPrevented).toBe(false);
    expect(content.style.transform).toBe('');
    settleMotion();
    expect(viewport.scrollTop).toBe(stopped);
  });

  it('retains fractional final paint without locking input or stranding it on cancellation', async () => {
    await mount();
    const kernel = scroller as unknown as { moveToOffset(offset: number): void };
    kernel.moveToOffset(100.4);
    settleMotion();
    await deliverBrowserLayout();
    expect(viewport.scrollTop).toBe(100);
    expect(translation()).toBeCloseTo(-0.4, 3);
    expect(getComputedStyle(viewport).overflowY).toBe('auto');
    const wheel = new WheelEvent('wheel', { deltaY: -20, cancelable: true });
    viewport.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(content.style.transform).toBe('');
  });

  it.each(['unbind', 'destroy'] as const)(
    'releases saved styles during %s even after the viewport is hidden',
    async (operation) => {
      viewport.style.overflowY = 'scroll';
      viewport.style.scrollbarGutter = 'stable both-edges';
      await mount();
      scroller!.removeItem(11);
      const stale = [...frames.values()];
      expect(viewport.style.overflowY).toBe('hidden');
      viewport.style.display = 'none';
      expect(viewport.scrollTop).toBe(0);
      scroller![operation]();
      scroller![operation]();
      for (const callback of stale) callback(now + 16);
      expect(content.style.transform).toBe('');
      expect(viewport.style.overflowY).toBe('scroll');
      expect(viewport.style.scrollbarGutter).toBe('stable both-edges');
      const kernel = scroller as unknown as { translateY: number; outOfBounds: boolean };
      expect(kernel.translateY).toBe(0);
      expect(kernel.outOfBounds).toBe(false);
      expect(frames.size).toBe(0);
    },
  );

  it('hidden viewport resize ends motion and releases all presentation styles', async () => {
    viewport.style.overflowY = 'auto';
    viewport.style.scrollbarGutter = 'stable both-edges';
    await mount();
    scroller!.removeItem(11);
    const stale = [...frames.values()];
    viewport.style.display = 'none';
    await deliverBrowserLayout();
    for (const callback of stale) callback(now + 16);
    vi.advanceTimersByTime(200);
    settleMotion();
    expect(content.style.transform).toBe('');
    expect(viewport.style.overflowY).toBe('auto');
    expect(viewport.style.scrollbarGutter).toBe('stable both-edges');
  });

  it('compensates native bottom clamping after deletion without moving a surviving row', async () => {
    await mount();
    const before = paintedTop(6);
    expect(before).toBe(0);

    expect(scroller!.removeItem(11)).toBe(1);

    expect(content.offsetHeight).toBe(1100);
    expect(viewport.scrollHeight).toBe(1100);
    expect(viewport.scrollTop).toBe(500);
    expect(translation()).toBe(-100);
    const wheel = new WheelEvent('wheel', { deltaY: -20, cancelable: true });
    viewport.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(getComputedStyle(viewport).overflowY).toBe('hidden');
    expect(paintedTop(6)).toBeCloseTo(before, 3);
    expectModelMatchesDOM();
    await deliverBrowserLayout();
    expect(paintedTop(6)).toBeCloseTo(before, 3);
    step();
    expect(paintedTop(6)).toBeGreaterThan(before);
    expect(paintedTop(6)).toBeLessThan(100);
    settleMotion();
    expect(viewport.scrollTop).toBe(500);
    expect(content.style.transform).toBe('');
    expect(paintedTop(6)).toBe(100);
    expectModelMatchesDOM();
  });

  it('rebases a second deletion during rebound without a painted discontinuity', async () => {
    await mount();
    scroller!.removeItem(11);
    step();
    const before = paintedTop(6);
    expect(scroller!.removeItem(10)).toBe(1);
    expect(viewport.scrollTop).toBe(400);
    expect(paintedTop(6)).toBeCloseTo(before, 3);
    expectModelMatchesDOM();
    settleMotion();
    expect(viewport.scrollTop).toBe(400);
    expect(paintedTop(6)).toBe(200);
    expect(content.style.transform).toBe('');
  });

  it('preserves short-stack alignment when a row grows across the viewport height', async () => {
    await mount(5);
    const before = paintedTop(0);
    expect(before).toBe(100);
    expect(row(0).offsetTop).toBe(100);
    expect(scroller!.mutateItem(4, (item) => ({ ...item, data: 300 }))).toBe(
      true,
    );
    expect(content.offsetHeight).toBe(700);
    expect(row(0).offsetTop).toBe(0);
    expect(row(4).offsetHeight).toBe(300);
    expect(paintedTop(0)).toBeCloseTo(before, 3);
    expect(translation()).toBe(100);
    expectModelMatchesDOM();
    await deliverBrowserLayout();
    expect(paintedTop(0)).toBeCloseTo(before, 3);
    settleMotion();
    expect(viewport.scrollTop).toBe(0);
    expect(content.style.transform).toBe('');
    expect(viewport.scrollHeight).toBe(700);
    expectModelMatchesDOM();
  });

  it('compensates the flex-end alignment change when deletions make a tall stack short', async () => {
    await mount(7);
    const before = paintedTop(1);
    expect(scroller!.removeItem([6, 5])).toBe(2);
    expect(content.offsetHeight).toBe(600);
    expect(viewport.scrollTop).toBe(0);
    expect(row(0).offsetTop).toBe(100);
    expect(translation()).toBe(-200);
    expect(paintedTop(1)).toBeCloseTo(before, 3);
    expectModelMatchesDOM();
    settleMotion();
    expect(content.style.transform).toBe('');
    expect(paintedTop(1)).toBe(200);
    expect(viewport.scrollHeight).toBe(600);
  });

  it('keeps an existing scrollbar gutter stable throughout compensation and release', async () => {
    viewport.classList.add('with-scrollbar');
    // Reserve real layout space even when headless Chromium uses overlay chrome.
    viewport.style.scrollbarGutter = 'stable';
    await mount();
    const width = content.clientWidth;
    expect(width).toBe(484);
    scroller!.removeItem(11);
    expect(getComputedStyle(viewport).overflowY).toBe('hidden');
    expect(content.clientWidth).toBe(width);
    await deliverBrowserLayout();
    expect(content.clientWidth).toBe(width);
    expect(translation()).toBe(-100);
    settleMotion();
    expect(content.clientWidth).toBe(width);
    expect(getComputedStyle(viewport).overflowY).toBe('auto');
    expect(content.style.transform).toBe('');
    await deliverBrowserLayout();
    expectModelMatchesDOM();
  });

  it('does not introduce a scrollbar-width reflow while compensating a short stack', async () => {
    viewport.classList.add('with-scrollbar');
    await mount(3);
    const width = content.clientWidth;
    const before = paintedTop(0);
    expect(width).toBe(500);
    expect(scroller!.mutateItem(2, (item) => ({ ...item, data: 200 }))).toBe(
      true,
    );
    expect(paintedTop(0)).toBeCloseTo(before, 3);
    expect(content.clientWidth).toBe(width);
    await deliverBrowserLayout();
    expect(content.clientWidth).toBe(width);
    expect(paintedTop(0)).toBeCloseTo(before, 3);
    settleMotion();
    expect(content.style.transform).toBe('');
    expect(content.clientWidth).toBe(width);
    expectModelMatchesDOM();
  });

  it('settles actual viewport resizing and rejects motion frames cancelled by resize', async () => {
    await mount();
    scroller!.removeItem(11);
    const stale = [...frames.values()];
    expect(translation()).toBe(-100);
    viewport.style.height = '450px';
    viewport.style.width = '400px';
    await deliverBrowserLayout();
    expect(viewport.clientHeight).toBe(450);
    expect(viewport.clientWidth).toBe(400);
    expect(content.style.transform).toBe('');
    for (const callback of stale) callback(now + 16);
    expect(content.style.transform).toBe('');
    vi.advanceTimersByTime(200);
    settleMotion();
    await deliverBrowserLayout();
    expect(scroller!.getInfo().viewportHeight).toBe(450);
    expect(viewport.scrollTop).toBe(650);
    expect(paintedTop(10) + row(10).offsetHeight).toBe(450);
    expectModelMatchesDOM();
    vi.advanceTimersByTime(1000);
    settleMotion();
    expect(viewport.scrollTop).toBe(650);
    expect(content.style.transform).toBe('');
  });
});
