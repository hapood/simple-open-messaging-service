import { NEVER, Subject } from 'rxjs';
import {
  ChatBoxScroller,
  type CbItem,
  type CbElement,
  type CbHooks,
  type CbOptions,
} from './chat-box-scroller';
import type { CbSource, CbDemandResult } from './cb-source';

/** Deterministic browser geometry with a real, explicitly advanced animation clock. */
describe('chat motion integration', () => {
  let viewport: HTMLDivElement;
  let content: HTMLDivElement;
  let scroller: ChatBoxScroller<number>;
  let source: CbSource<number>;
  let newer: Subject<CbDemandResult<number>>;
  let heights: Map<number, number>;
  let frames: Map<number, FrameRequestCallback>;
  let now: number;
  let nextFrame: number;
  let rows: CbItem<number>[];
  let roundScrollTop: boolean;

  function step(ms = 16): void {
    now += ms;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  }

  function settle(): void {
    for (let i = 0; i < 500 && frames.size; i++) step();
    expect(frames.size).toBe(0);
  }

  function visualOffset(): number {
    const transform = content.style.transform;
    const y = transform
      ? Number(/translateY\(([-\d.]+)px\)/.exec(transform)?.[1] ?? 0)
      : 0;
    return viewport.scrollTop - y;
  }

  async function mount(
    count = 12,
    extraHooks: Partial<CbHooks<number>> = {},
    configure?: (source: CbSource<number>, rows: CbItem<number>[]) => void,
    onWindowJump?: CbOptions<number>['onWindowJump'],
  ): Promise<void> {
    rows = Array.from({ length: count }, (_, id) => ({
      id,
      data: id,
      ...(id === 0 ? { boundary: 'oldest' as const } : {}),
      ...(id === count - 1 ? { boundary: 'newest' as const } : {}),
    }));
    source = {
      loadWindow: async () => rows,
      requestOlder: () => NEVER,
      requestNewer: () => newer,
      requestMessagesForEmptyWindow: () => newer,
      pushLive: (items) => newer.next({ kind: 'items', items }),
      destroy: () => {},
    };
    configure?.(source, rows);
    scroller = new ChatBoxScroller({
      viewport,
      content,
      config: { thresholdFloor: 20000, initBatch: count },
      onWindowJump,
      hooks: {
        createItem: (item) => {
          const el = document.createElement('div');
          let current = item;
          Object.defineProperty(el, 'offsetHeight', {
            configurable: true,
            get: () => heights.get(current.id) ?? 100,
          });
          return {
            el,
            update: (next) => {
              current = next;
            },
            predestory: () => {},
            destroy: () => {},
          } satisfies CbElement<number>;
        },
        ...extraHooks,
      },
    });
    scroller.bind(source);
    await scroller.openWindow({ kind: 'latest' });
    settle();
  }

  beforeEach(() => {
    now = 0;
    roundScrollTop = false;
    nextFrame = 0;
    frames = new Map();
    heights = new Map();
    newer = new Subject();
    viewport = document.createElement('div');
    content = document.createElement('div');
    viewport.append(content);
    document.body.append(viewport);
    Object.defineProperty(viewport, 'clientHeight', {
      configurable: true,
      get: () => 600,
    });
    Object.defineProperty(content, 'scrollHeight', {
      configurable: true,
      get: () =>
        [...content.children].reduce(
          (sum, el) => sum + (el as HTMLElement).offsetHeight,
          0,
        ),
    });
    let scrollTop = 0;
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () =>
        Math.max(
          0,
          Math.min(scrollTop, Math.max(0, content.scrollHeight - 600)),
        ),
      set: (value: number) => {
        scrollTop = Math.max(
          0,
          Math.min(roundScrollTop ? Math.round(value) : value, Math.max(0, content.scrollHeight - 600)),
        );
      },
    });
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }));
  });

  afterEach(() => {
    scroller?.destroy();
    viewport.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('search navigation never delegates animation to native smooth scrolling', async () => {
    await mount();
    const nativeScroll = vi.spyOn(viewport, 'scrollTo');
    await scroller.smoothScrollToMessage(0, 0, true);
    expect(viewport.scrollTop).toBe(600);
    step();
    expect(viewport.scrollTop).toBeLessThan(600);
    settle();
    expect(viewport.scrollTop).toBe(0);
    expect(nativeScroll).not.toHaveBeenCalled();
  });

  it('go-to-latest uses the same progressing motion rather than snapping', async () => {
    await mount();
    viewport.scrollTop = 100;
    await scroller.goToLatest();
    expect(viewport.scrollTop).toBe(100);
    step();
    expect(viewport.scrollTop).toBeGreaterThan(100);
    expect(viewport.scrollTop).toBeLessThan(600);
    settle();
    expect(viewport.scrollTop).toBe(600);
  });

  it('does not move an already fully visible message without overscroll', async () => {
    await mount();
    viewport.scrollTop = 300;
    await scroller.smoothScrollToMessage(4);
    settle();
    expect(viewport.scrollTop).toBe(300);
  });

  it.each([
    [4, 280],
    [7, 320],
  ])(
    'chooses overscroll direction from message %s relative to midpoint',
    async (id, expected) => {
      await mount();
      viewport.scrollTop = 300;
      await scroller.smoothScrollToMessage(id, 20);
      settle();
      expect(viewport.scrollTop).toBe(expected);
    },
  );

  it('keeps the downward tie-break when the message and viewport midpoints coincide', async () => {
    await mount();
    viewport.scrollTop = 250;
    await scroller.smoothScrollToMessage(5, 20);
    settle();
    // Equal midpoints use the downward tie-break and keep the current reveal.
    expect(viewport.scrollTop).toBe(270);
  });

  it('treats a negative overscroll as zero', async () => {
    await mount();
    viewport.scrollTop = 300;
    await scroller.smoothScrollToMessage(4, -20);
    settle();
    expect(viewport.scrollTop).toBe(300);
    viewport.scrollTop = 300;
    await scroller.smoothScrollToMessage(0, -20);
    settle();
    expect(viewport.scrollTop).toBe(0);
  });

  it('clamps overscroll at the real content boundary', async () => {
    await mount();
    await scroller.smoothScrollToMessage(11, 100);
    settle();
    expect(viewport.scrollTop).toBe(600);
    expect(content.style.transform).toBe('');
  });

  it('preserves forward movement while decelerating toward a reversed target', async () => {
    await mount();
    viewport.scrollTop = 0;
    await scroller.goToLatest();
    for (let i = 0; i < 8; i++) step();
    const before = visualOffset();
    await scroller.smoothScrollToMessage(0);
    step();
    expect(visualOffset()).toBeGreaterThan(before);
    settle();
    expect(viewport.scrollTop).toBe(0);
  });

  it('cancels normal following on user upward wheel input', async () => {
    await mount();
    viewport.scrollTop = 100;
    await scroller.goToLatest();
    step();
    viewport.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -100, cancelable: true }),
    );
    const stopped = viewport.scrollTop;
    settle();
    expect(viewport.scrollTop).toBe(stopped);
  });

  it.each(['wheel', 'touchmove', 'keydown', 'scroll'])(
    'rounded scroll writes remain interruptible by %s without a residual transform',
    async (kind) => {
      roundScrollTop = true;
      await mount();
      viewport.scrollTop = 100;
      await scroller.goToLatest();
      step();
      expect(content.style.transform).not.toBe('');
      expect(viewport.style.overflowY).not.toBe('hidden');
      // The asynchronous notification of our rounded write must not stop motion.
      viewport.dispatchEvent(new Event('scroll'));
      const before = visualOffset();
      step();
      expect(visualOffset()).toBeGreaterThan(before);
      const event = kind === 'wheel'
        ? new WheelEvent(kind, { deltaY: -20, cancelable: true })
        : kind === 'keydown'
          ? new KeyboardEvent(kind, { key: 'ArrowUp', cancelable: true })
          : new Event(kind, { cancelable: true });
      if (kind === 'scroll') viewport.scrollTop -= 20;
      viewport.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      const stopped = viewport.scrollTop;
      settle();
      expect(viewport.scrollTop).toBe(stopped);
      expect(content.style.transform).toBe('');
    },
  );

  it('does not mistake a fractional native user scroll for its own write', async () => {
    await mount();
    viewport.scrollTop = 100;
    await scroller.goToLatest();
    step();
    viewport.scrollTop -= 0.4;
    viewport.dispatchEvent(new Event('scroll'));
    const stopped = viewport.scrollTop;
    settle();
    expect(viewport.scrollTop).toBe(stopped);
  });

  it('keeps a legal fractional final offset unlocked and never starts a rounding rebound', async () => {
    roundScrollTop = true;
    await mount();
    const kernel = scroller as unknown as {
      moveToOffset(offset: number): void;
      snapshotLayout(): unknown;
      restoreLayout(layout: unknown): boolean;
    };
    kernel.moveToOffset(100.4);
    settle();
    expect(viewport.scrollTop).toBe(100);
    expect(visualOffset()).toBeCloseTo(100.4, 5);
    expect(viewport.style.overflowY).not.toBe('hidden');
    kernel.restoreLayout(kernel.snapshotLayout());
    expect(frames.size).toBe(0);
    const wheel = new WheelEvent('wheel', { deltaY: -20, cancelable: true });
    viewport.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(content.style.transform).toBe('');
  });

  it('removal at bottom preserves a surviving visual anchor before rebounding', async () => {
    await mount();
    const before = visualOffset();
    scroller.removeItem(11);
    expect(visualOffset()).toBeCloseTo(before, 5);
    expect(content.style.transform).not.toBe('');
    settle();
    expect(viewport.scrollTop).toBe(500);
    expect(content.style.transform).toBe('');
  });

  it('allows a second layout update during rebound without a visual discontinuity', async () => {
    await mount();
    scroller.removeItem(11);
    step();
    const before = visualOffset();
    scroller.removeItem(10);
    expect(visualOffset()).toBeCloseTo(before, 5);
    settle();
    expect(viewport.scrollTop).toBe(400);
    expect(content.style.transform).toBe('');
  });

  it('suppresses user scrolling only while a rebound compensation exists', async () => {
    await mount();
    scroller.removeItem(11);
    const wheel = new WheelEvent('wheel', { deltaY: -20, cancelable: true });
    viewport.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    settle();
    const after = new WheelEvent('wheel', { deltaY: -20, cancelable: true });
    viewport.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it.each([420, 421])(
    'admits growth %s at the fixed 120ms / 70 percent boundary',
    async (growth) => {
      await mount();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      heights.set(12, growth);
      source.pushLive([{ id: 12, data: 12, boundary: 'newest' }]);
      step();
      expect(viewport.scrollTop).toBe(600);
      vi.advanceTimersByTime(119);
      step();
      expect(viewport.scrollTop).toBe(600);
      vi.advanceTimersByTime(1);
      settle();
      expect(viewport.scrollTop).toBe(growth === 420 ? 1020 : 620);
    },
  );

  it('coalesces arrivals without extending the first 120ms deadline', async () => {
    await mount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    source.pushLive([{ id: 12, data: 12, boundary: 'newest' }]);
    step();
    vi.advanceTimersByTime(80);
    source.pushLive([{ id: 13, data: 13, boundary: 'newest' }]);
    step();
    vi.advanceTimersByTime(40);
    settle();
    expect(viewport.scrollTop).toBe(800);
  });

  it('counts new members absorbed into an existing album even without a new mounted row', async () => {
    await mount(12, {
      absorbTail: (tail, incoming) => {
        heights.set(tail.id, 200);
        return {
          ...tail,
          ids: [...(tail.ids ?? [tail.id]), incoming.id],
          boundary: 'newest',
        };
      },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    source.pushLive([{ id: 12, data: 12, boundary: 'newest' }]);
    step();
    expect(scroller.getInfo().mounted).toBe(12);
    expect(scroller.getMountedGeometry(12)).not.toBeNull();
    expect(viewport.scrollTop).toBe(600);
    vi.advanceTimersByTime(120);
    settle();
    expect(viewport.scrollTop).toBe(700);
  });

  it.each([true, false])(
    'only a latest display gap starts the arrival policy (latest=%s)',
    async (latest) => {
      const deliveries = new Subject<CbItem<number>[]>();
      const gapId = latest ? 11 : 5;
      await mount(12, {}, (backing, mounted) => {
        mounted[gapId] = {
          ...mounted[gapId],
          displayInterval: { left: gapId - 1, right: gapId },
        };
        backing.watchInterval = () => deliveries;
      });
      await Promise.resolve();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const replacement: CbItem<number>[] = [
        { id: gapId + 100, data: gapId + 100 },
        {
          id: gapId + 200,
          data: gapId + 200,
          ...(latest ? { boundary: 'newest' as const } : {}),
        },
      ];
      deliveries.next(replacement);
      step();
      const afterLayout = viewport.scrollTop;
      vi.advanceTimersByTime(120);
      settle();
      expect(viewport.scrollTop).toBe(latest ? 700 : afterLayout);
    },
  );

  it('tail presentation appears immediately and uses the shared motion without an animation gate', async () => {
    let tailHeight = 0;
    let tailHost!: HTMLElement;
    await mount(12, {
      createItem: (item) => {
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', {
          get: () => 100 + (item.id === 11 ? tailHeight : 0),
        });
        if (item.id === 11) tailHost = el;
        return {
          el,
          update: () => {},
          predestory: () => {},
          destroy: () => {},
          measureTailHeight: () => (item.id === 11 ? tailHeight : 0),
        };
      },
      updateTailPresentation: () => (tailHost ? [tailHost] : []),
    });
    tailHeight = 40;
    scroller.refreshTailPresentation();
    expect(tailHost.offsetHeight).toBe(140);
    expect(viewport.scrollTop).toBe(600);
    step();
    expect(viewport.scrollTop).toBeGreaterThan(600);
    tailHeight = 0;
    scroller.refreshTailPresentation();
    expect(tailHost.offsetHeight).toBe(100);
    // A new mutation is admitted while the shared motion is still running.
    scroller.mutateItem(10, (item) => ({ ...item }));
    settle();
    expect(viewport.scrollTop).toBe(600);
    expect(content.style.transform).toBe('');
  });

  it('resolves a non-head album member through the same public message API', async () => {
    await mount();
    scroller.mutateItem(4, (item) => ({ ...item, ids: [4, 104] }));
    viewport.scrollTop = 600;
    await scroller.smoothScrollToMessage(104);
    settle();
    expect(viewport.scrollTop).toBe(400);
  });

  it('does not let an in-flight bottom target chase unapproved arrivals', async () => {
    await mount();
    viewport.scrollTop = 100;
    await scroller.goToLatest();
    for (let i = 0; i < 5; i++) step();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    source.pushLive([{ id: 12, data: 12, boundary: 'newest' }]);
    settle();
    expect(viewport.scrollTop).toBe(600);
    vi.advanceTimersByTime(120);
    settle();
    expect(viewport.scrollTop).toBe(700);
  });

  it('a short-content update can rebase a running transform without clearing it first', async () => {
    await mount(3);
    scroller.insertAfter(2, { id: 3, data: 3 });
    step();
    const before = visualOffset();
    // Another 100px inserted below the same surviving messages moves their
    // bottom-aligned layout tops upward by 100px; offset must move with them.
    scroller.insertAfter(3, { id: 4, data: 4 });
    expect(visualOffset()).toBeCloseTo(before - 100, 5);
    settle();
    expect(viewport.scrollTop).toBe(0);
    expect(content.style.transform).toBe('');
  });

  it('releases the input lock as soon as new geometry fills the rebound gap', async () => {
    await mount();
    scroller.removeItem(11);
    step();
    const before = visualOffset();
    scroller.insertAfter(10, { id: 12, data: 12 });
    expect(visualOffset()).toBeCloseTo(before, 5);
    expect(content.style.transform).toBe('');
    const wheel = new WheelEvent('wheel', { deltaY: -20, cancelable: true });
    viewport.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });

  it('keeps text editing and non-scroll pointer interactions available during compensation', async () => {
    await mount();
    const input = document.createElement('input');
    viewport.append(input);
    scroller.removeItem(11);
    const key = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    const home = new KeyboardEvent('keydown', {
      key: 'Home',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(home);
    expect(home.defaultPrevented).toBe(false);
    const click = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it('does not repeatedly accumulate the reveal distance on every frame', async () => {
    await mount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    heights.set(12, 800);
    source.pushLive([{ id: 12, data: 12, boundary: 'newest' }]);
    step();
    vi.advanceTimersByTime(120);
    settle();
    for (let i = 0; i < 10; i++) {
      scroller.refresh();
      step();
    }
    settle();
    expect(viewport.scrollTop).toBe(620);
  });

  it('resizing clears compensation and does not allow a revoked frame to repaint it', async () => {
    await mount();
    scroller.removeItem(11);
    const stale = [...frames.values()];
    scroller.scheduleLayoutRemeasure();
    for (const callback of stale) callback(now + 16);
    expect(content.style.transform).toBe('');
    expect(viewport.scrollTop).toBe(500);
  });

  it('falls back to a legal unanimated position when no message survives', async () => {
    await mount();
    await scroller.smoothScrollToMessage(0);
    step();
    scroller.removeItem(rows.map((row) => row.id));
    settle();
    expect(viewport.scrollTop).toBe(0);
    expect(content.style.transform).toBe('');
  });

  it('reuses immutable scalar rows until layout geometry changes', async () => {
    await mount();
    const kernel = scroller as unknown as {
      snapshotLayout(): {
        rows: readonly { ids: readonly number[]; height: number }[];
      };
    };
    const before = kernel.snapshotLayout();
    viewport.scrollTop = 100;
    await scroller.goToLatest();
    step();
    expect(kernel.snapshotLayout().rows).toBe(before.rows);
    scroller.mutateItem(4, (item) => ({ ...item, ids: [4, 104] }));
    const after = kernel.snapshotLayout();
    expect(after.rows).not.toBe(before.rows);
    expect(before.rows[4].ids).toEqual([4]);
    expect(after.rows[4].ids).toEqual([4, 104]);
    expect(Object.isFrozen(after.rows)).toBe(true);
  });

  it('settles a rebound even when a fully visible message supersedes navigation', async () => {
    await mount();
    scroller.removeItem(11);
    await scroller.smoothScrollToMessage(8);
    settle();
    expect(visualOffset()).toBe(500);
    expect(content.style.transform).toBe('');
    const wheel = new WheelEvent('wheel', { deltaY: -20, cancelable: true });
    viewport.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });

  it('preserves compensation while older history is prepended during rebound', async () => {
    await mount();
    scroller.removeItem(11);
    step();
    const before = visualOffset();
    const kernel = scroller as unknown as {
      applyOlderResult(result: CbDemandResult<number>): boolean;
    };
    kernel.applyOlderResult({
      kind: 'items',
      items: [{ id: -1, data: -1, boundary: 'oldest' }],
    });
    expect(visualOffset()).toBeCloseTo(before + 100, 5);
    expect(content.style.transform).not.toBe('');
    settle();
    expect(viewport.scrollTop).toBe(600);
    expect(content.style.transform).toBe('');
  });

  it('subtracts a shrinking reserve from an approved target exactly once', async () => {
    await mount();
    const reserve = content.querySelector<HTMLElement>('.cb-bottom-reserve')!;
    let reserveHeight = 100;
    Object.defineProperty(reserve, 'offsetHeight', {
      configurable: true,
      get: () => reserveHeight,
    });
    const kernel = scroller as unknown as { onRegionResize(): void };
    kernel.onRegionResize();
    viewport.scrollTop = 100;
    await scroller.goToLatest();
    step();
    reserveHeight = 0;
    kernel.onRegionResize();
    settle();
    expect(viewport.scrollTop).toBe(600);
  });

  it('rebases an accepted bottom flight only once across nested renderer teardown', async () => {
    let armed = false;
    await mount(12, {
      createItem: (item) => {
        const el = document.createElement('div');
        Object.defineProperty(el, 'offsetHeight', { get: () => 100 });
        return {
          el,
          update: () => {},
          destroy: () => {},
          predestory: () => {
            if (armed && item.id === 10) {
              armed = false;
              scroller.removeItem(0);
            }
          },
        };
      },
    });
    viewport.scrollTop = 300;
    await scroller.goToLatest();
    step();
    armed = true;
    scroller.mutateItem(10, (item) => ({ ...item }));
    settle();
    expect(viewport.scrollTop).toBe(500);
  });

  it('does not approve arrivals at the local bottom of an incomplete history window', async () => {
    await mount(12, {}, (_source, mounted) => {
      delete mounted[11].boundary;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const before = viewport.scrollTop;
    source.pushLive([{ id: 12, data: 12 }]);
    step();
    vi.advanceTimersByTime(120);
    settle();
    expect(viewport.scrollTop).toBe(before);
  });

  it('rejects an older navigation after changing conversations and returning to the same chat', async () => {
    let resolve!: (opened: boolean) => void;
    await mount(
      12,
      {},
      undefined,
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    scroller.unbind();
    scroller.bind(source, { chatId: 7 });
    await scroller.openWindow({ kind: 'latest' });
    const pending = scroller.smoothScrollToMessage(50);
    scroller.unbind();
    scroller.bind(source, { chatId: 8 });
    await scroller.openWindow({ kind: 'latest' });
    scroller.unbind();
    rows = rows.map((row) => ({ ...row, id: row.id + 50 }));
    scroller.bind(source, { chatId: 7 });
    await scroller.openWindow({ kind: 'latest' });
    resolve(true);
    expect(await pending).toBe(false);
  });

  it.each(['wheel', 'scroll'])(
    'user %s supersedes a pending asynchronous navigation',
    async (kind) => {
      let resolve!: (opened: boolean) => void;
      await mount(
        12,
        {},
        undefined,
        () =>
          new Promise<boolean>((done) => {
            resolve = done;
          }),
      );
      const pending = scroller.smoothScrollToMessage(50);
      if (kind === 'wheel')
        viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }));
      else {
        viewport.scrollTop = 100;
        viewport.dispatchEvent(new Event('scroll'));
      }
      scroller.insertAfter(11, { id: 50, data: 50 });
      resolve(true);
      expect(await pending).toBe(false);
    },
  );

  it('revokes all motion when unbound, including stale frame callbacks', async () => {
    await mount();
    viewport.scrollTop = 100;
    await scroller.goToLatest();
    const stale = [...frames.values()];
    scroller.unbind();
    for (const callback of stale) callback(now + 16);
    expect(viewport.scrollTop).toBe(0);
    expect(content.style.transform).toBe('');
    expect(frames.size).toBe(0);
  });
});
