import { NEVER, Subject } from 'rxjs';
import { jumpToMessage } from '../../components/message-thread/message-jump';
import type { CbDemandResult, CbSource } from './cb-source';
import {
  ChatBoxScroller,
  type CbElement,
  type CbHooks,
  type CbItem,
  type CbOptions,
} from './chat-box-scroller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Public navigation contract with clamped browser geometry and a manual RAF clock. */
describe('chat navigation lifecycle', () => {
  let viewport: HTMLDivElement;
  let content: HTMLDivElement;
  let scroller: ChatBoxScroller<number>;
  let frames: Map<number, FrameRequestCallback>;
  let now: number;
  let nextFrame: number;

  function step(): void {
    now += 16;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  }

  function settle(): void {
    for (let i = 0; i < 500 && frames.size; i++) step();
    expect(frames.size).toBe(0);
  }

  function rows(first = 0): CbItem<number>[] {
    return Array.from({ length: 12 }, (_, index) => ({
      id: first + index,
      data: first + index,
      ...(index === 0 ? { boundary: 'oldest' as const } : {}),
      ...(index === 11 ? { boundary: 'newest' as const } : {}),
    }));
  }

  function sourceFor(items = rows()): CbSource<number> {
    const newer = new Subject<CbDemandResult<number>>();
    return {
      loadWindow: async () => items,
      requestOlder: () => NEVER,
      requestNewer: () => newer,
      requestMessagesForEmptyWindow: () => NEVER,
      pushLive: (incoming) => newer.next({ kind: 'items', items: incoming }),
      destroy: () => newer.complete(),
    };
  }

  async function mount(
    onWindowJump?: CbOptions<number>['onWindowJump'],
    extraHooks: Partial<CbHooks<number>> = {},
  ): Promise<CbSource<number>> {
    const source = sourceFor();
    scroller = new ChatBoxScroller({
      viewport,
      content,
      config: { thresholdFloor: 20000, initBatch: 12 },
      onWindowJump,
      hooks: {
        createItem: () => {
          const el = document.createElement('div');
          Object.defineProperty(el, 'offsetHeight', { get: () => 100 });
          return {
            el,
            update: () => {},
            predestory: () => {},
            destroy: () => {},
          } satisfies CbElement<number>;
        },
        ...extraHooks,
      },
    });
    scroller.bind(source, { chatId: 7 });
    await scroller.openWindow({ kind: 'latest' });
    settle();
    return source;
  }

  beforeEach(() => {
    now = 0;
    nextFrame = 0;
    frames = new Map();
    viewport = document.createElement('div');
    content = document.createElement('div');
    viewport.append(content);
    document.body.append(viewport);
    Object.defineProperty(viewport, 'clientHeight', { get: () => 600 });
    Object.defineProperty(content, 'scrollHeight', {
      get: () =>
        [...content.children].reduce(
          (sum, el) => sum + (el as HTMLElement).offsetHeight,
          0,
        ),
    });
    let scrollTop = 0;
    const clamp = (value: number) =>
      Math.max(0, Math.min(value, Math.max(0, content.scrollHeight - 600)));
    Object.defineProperty(viewport, 'scrollTop', {
      get: () => clamp(scrollTop),
      set: (value: number) => {
        scrollTop = clamp(value);
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
    vi.restoreAllMocks();
  });

  it('hands an unmounted target to the host and waits for its same-chat skeleton/load handshake', async () => {
    const load = deferred<CbItem<number>[]>();
    const replacement = sourceFor();
    replacement.loadWindow = vi.fn(() => load.promise);
    // Whole-window skeleton presentation belongs to the host, not a kernel row.
    const skeleton = document.createElement('div');
    skeleton.hidden = true;
    viewport.append(skeleton);
    const jump = vi.fn<CbOptions<number>['onWindowJump'] & {}>(
      async (request) => {
        skeleton.hidden = false;
        scroller.unbind();
        scroller.bind(replacement, { chatId: 7 });
        await scroller.openWindow(request);
        skeleton.hidden = true;
        return (
          request.kind === 'message' &&
          scroller.getMountedGeometry(request.messageId) !== null
        );
      },
    );
    const original = await mount(jump);
    const originalLoad = vi.spyOn(original, 'loadWindow');
    let finished = false;
    const pending = scroller.smoothScrollToMessage(104, 20).then((found) => {
      finished = true;
      return found;
    });

    expect(jump).toHaveBeenCalledExactlyOnceWith({
      kind: 'message',
      messageId: 104,
      anchor: 'center',
      highlight: false,
    });
    expect(replacement.loadWindow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'around', messageId: 104 }),
      expect.anything(),
    );
    expect(originalLoad).not.toHaveBeenCalled();
    expect(skeleton.hidden).toBe(false);
    expect(scroller.getInfo().mounted).toBe(0);
    expect(finished).toBe(false);
    step();
    expect(finished).toBe(false);

    load.resolve(rows(100));
    expect(await pending).toBe(true);
    expect(skeleton.hidden).toBe(true);
    expect(scroller.lifecycleState).toBe('steady');
    settle();
    const target = scroller.getMountedGeometry(104)!;
    expect(target.top).toBeGreaterThanOrEqual(0);
    expect(target.bottom).toBeLessThanOrEqual(600);
    expect(content.style.transform).toBe('');
  });

  it('returns missing when the host cannot establish the target, without starting motion', async () => {
    const result = deferred<boolean>();
    const jump = vi.fn(() => result.promise);
    await mount(jump);
    viewport.scrollTop = 300;
    const pending = scroller.smoothScrollToMessage(999, 20, true);
    result.resolve(false);
    expect(await pending).toBe(false);
    settle();
    expect(viewport.scrollTop).toBe(300);
    expect(content.querySelector('.cb-jump-highlight')).toBeNull();
  });

  it('a newer mounted request supersedes an older pending window request', async () => {
    const result = deferred<boolean>();
    const jump = vi.fn(() => result.promise);
    await mount(jump);
    const oldRequest = scroller.smoothScrollToMessage(104, 20, true);
    // The host has loaded the requested window but has not acknowledged it yet.
    scroller.unbind();
    scroller.bind(sourceFor(rows(100)), { chatId: 7 });
    await scroller.openWindow({ kind: 'latest' });
    expect(await scroller.smoothScrollToMessage(101)).toBe(true);
    settle();
    expect(viewport.scrollTop).toBe(100);

    result.resolve(true);
    expect(await oldRequest).toBe(false);
    settle();
    expect(viewport.scrollTop).toBe(100);
    expect(
      scroller
        .getMountedGeometry(104)!
        .el.classList.contains('cb-jump-highlight'),
    ).toBe(false);
    expect(jump).toHaveBeenCalledTimes(1);
  });

  it.each([NaN, Infinity, -Infinity])(
    'rejects nonfinite overscroll %s without disturbing current motion',
    async (overscroll) => {
      await mount();
      viewport.scrollTop = 100;
      await scroller.goToLatest();
      await expect(
        scroller.smoothScrollToMessage(4, overscroll),
      ).rejects.toThrow(RangeError);
      settle();
      expect(viewport.scrollTop).toBe(600);
      expect(content.style.transform).toBe('');
    },
  );

  it('go-to-latest supersedes an older pending message request', async () => {
    const result = deferred<boolean>();
    await mount(() => result.promise);
    const pending = scroller.smoothScrollToMessage(104, 20, true);
    scroller.unbind();
    scroller.bind(sourceFor(rows(100)), { chatId: 7 });
    await scroller.openWindow({ kind: 'latest' });
    viewport.scrollTop = 100;
    expect(await scroller.goToLatest()).toBe(true);
    settle();
    expect(viewport.scrollTop).toBe(600);

    result.resolve(true);
    expect(await pending).toBe(false);
    settle();
    expect(viewport.scrollTop).toBe(600);
    expect(
      scroller
        .getMountedGeometry(104)!
        .el.classList.contains('cb-jump-highlight'),
    ).toBe(false);
  });

  it('rejects a late host acknowledgement after switching to another conversation', async () => {
    const result = deferred<boolean>();
    await mount(() => result.promise);
    const pending = scroller.smoothScrollToMessage(104, 20, true);
    scroller.unbind();
    // Reuse the same numeric target deliberately: geometry alone cannot authorize it.
    scroller.bind(sourceFor(rows(100)), { chatId: 8 });
    await scroller.openWindow({ kind: 'latest' });
    viewport.scrollTop = 300;
    result.resolve(true);
    expect(await pending).toBe(false);
    settle();
    expect(viewport.scrollTop).toBe(300);
    expect(
      scroller
        .getMountedGeometry(104)!
        .el.classList.contains('cb-jump-highlight'),
    ).toBe(false);
  });

  it('rejects a late host acknowledgement after switching from chat 7 to 8 and back to 7', async () => {
    const result = deferred<boolean>();
    const jump = vi.fn(() => result.promise);
    await mount(jump);
    const pending = scroller.smoothScrollToMessage(104, 20, true);

    scroller.unbind();
    scroller.bind(sourceFor(rows(100)), { chatId: 8 });
    await scroller.openWindow({ kind: 'latest' });
    scroller.unbind();
    // Returning to the original chat is not the requested same-chat successor.
    // Keep the target mounted so identity lookup cannot hide stale ownership.
    scroller.bind(sourceFor(rows(100)), { chatId: 7 });
    await scroller.openWindow({ kind: 'latest' });
    settle();
    viewport.scrollTop = 300;

    result.resolve(true);
    expect(await pending).toBe(false);
    settle();
    expect(viewport.scrollTop).toBe(300);
    expect(content.style.transform).toBe('');
    expect(
      scroller
        .getMountedGeometry(104)!
        .el.classList.contains('cb-jump-highlight'),
    ).toBe(false);
    expect(jump).toHaveBeenCalledTimes(1);
  });

  it('rejects a pending navigation acknowledgement after the user scrolls upward', async () => {
    const result = deferred<boolean>();
    const jump = vi.fn(() => result.promise);
    await mount(jump);
    const pending = scroller.smoothScrollToMessage(104, 20, true);

    // The legitimate same-chat successor is loaded, but the host has not yet
    // acknowledged it. User scrolling must supersede the outstanding request.
    scroller.unbind();
    scroller.bind(sourceFor(rows(100)), { chatId: 7 });
    await scroller.openWindow({ kind: 'latest' });
    settle();
    expect(viewport.scrollTop).toBe(600);
    const wheel = new WheelEvent('wheel', {
      deltaY: -300,
      cancelable: true,
    });
    viewport.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    // Synthetic wheel events do not perform native scrolling in the browser.
    viewport.scrollTop = 300;
    viewport.dispatchEvent(new Event('scroll'));
    settle();

    result.resolve(true);
    expect(await pending).toBe(false);
    settle();
    expect(viewport.scrollTop).toBe(300);
    expect(content.style.transform).toBe('');
    expect(
      scroller
        .getMountedGeometry(104)!
        .el.classList.contains('cb-jump-highlight'),
    ).toBe(false);
    expect(jump).toHaveBeenCalledTimes(1);
  });

  it('resolves an unmounted non-head member after the source batch merges into an album', async () => {
    const jump = vi.fn<CbOptions<number>['onWindowJump'] & {}>(
      async (request) => {
        scroller.unbind();
        scroller.bind(sourceFor(rows(100)), { chatId: 7 });
        await scroller.openWindow(request);
        return true;
      },
    );
    await mount(jump, {
      mergeItems: (items) =>
        items.flatMap((item) => {
          if (item.id === 104) return [{ ...item, ids: [104, 105] }];
          return item.id === 105 ? [] : [item];
        }),
    });
    expect(await scroller.smoothScrollToMessage(105, 0, true)).toBe(true);
    settle();
    const member = scroller.getMountedGeometry(105)!;
    expect(member.el).toBe(scroller.getMountedGeometry(104)!.el);
    expect(member.item.ids).toEqual([104, 105]);
    expect(member.top).toBeGreaterThanOrEqual(0);
    expect(member.bottom).toBeLessThanOrEqual(600);
    expect(member.el.classList.contains('cb-jump-highlight')).toBe(true);
    expect(jump).toHaveBeenCalledTimes(1);
  });

  it('keeps an in-flight optimistic target through confirmation and a changed final position', async () => {
    const jump = vi.fn(async () => false);
    const source = await mount(jump);
    scroller.insertAfter(
      11,
      {
        id: -1,
        data: -1,
        clientMessageId: 'navigation-send',
      },
      { optimistic: true },
    );
    settle();
    viewport.scrollTop = 0;
    expect(await scroller.smoothScrollToMessage(-1)).toBe(true);
    for (let i = 0; i < 5; i++) step();
    expect(viewport.scrollTop).toBeGreaterThan(0);
    expect(viewport.scrollTop).toBeLessThan(700);

    // An unrelated row precedes confirmation, so retaining the old numeric offset
    // would leave the confirmed target below the fold.
    source.pushLive([
      { id: 12, data: 12 },
      {
        id: 13,
        data: 13,
        clientMessageId: 'navigation-send',
        boundary: 'newest',
      },
    ]);
    settle();
    expect(scroller.getMountedGeometry(-1)).toBeNull();
    expect(scroller.getInfo().mounted).toBe(14);
    expect(scroller.getMountedGeometry(13)!.bottom).toBe(600);
    expect(viewport.scrollTop).toBe(800);
    expect(jump).not.toHaveBeenCalled();
    expect(content.style.transform).toBe('');
  });

  it('search reveals 20px of context for an already visible result instead of centering it', async () => {
    const jump = vi.fn(async () => false);
    await mount(jump);
    viewport.scrollTop = 300;
    expect(await jumpToMessage(scroller, 4)).toBe(true);
    expect(viewport.scrollTop).toBe(300);
    step();
    expect(viewport.scrollTop).toBeLessThan(300);
    settle();
    expect(viewport.scrollTop).toBe(280);
    expect(
      scroller
        .getMountedGeometry(4)!
        .el.classList.contains('cb-jump-highlight'),
    ).toBe(true);
    expect(jump).not.toHaveBeenCalled();
  });

  it.each([3, 4, 8])(
    'zero overscroll leaves fully visible message %s in place, including viewport edges',
    async (id) => {
      const jump = vi.fn(async () => false);
      await mount(jump);
      viewport.scrollTop = 300;
      expect(await scroller.smoothScrollToMessage(id, 0, true)).toBe(true);
      settle();
      expect(viewport.scrollTop).toBe(300);
      expect(
        scroller
          .getMountedGeometry(id)!
          .el.classList.contains('cb-jump-highlight'),
      ).toBe(true);
      expect(jump).not.toHaveBeenCalled();
      expect(content.style.transform).toBe('');
    },
  );
});
