import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlipListAnimator, FlipListRow } from './flip-list';

const motion = { reduced: false };

describe('FlipListAnimator with a virtual window', () => {
  let container: HTMLElement;
  let animator: FlipListAnimator;
  let animate: ReturnType<typeof vi.fn>;
  let cancel: ReturnType<typeof vi.fn>;
  let layout: Map<string, FlipListRow>;
  let revisions: Map<string, number>;

  function render(keys: string[], start = 0, end = keys.length): HTMLElement[] {
    layout = new Map(
      keys.map((key, index) => [
        key,
        {
          top: index * 72,
          revision: String(revisions.get(key) ?? 0),
        },
      ]),
    );
    return mount(keys.slice(start, end));
  }

  function mount(keys: string[]): HTMLElement[] {
    container.replaceChildren();
    return keys.map((key) => {
      const row = document.createElement('button');
      row.dataset['flipKey'] = key;
      row.textContent = key;
      Object.defineProperties(row, {
        // Window-local offsetTop deliberately differs from the global position.
        offsetTop: { value: 0 },
        offsetLeft: { value: 0 },
        offsetHeight: { value: 72 },
        offsetWidth: { value: 320 },
      });
      container.append(row);
      return row;
    });
  }

  function play(changed: string[] = []): void {
    if (changed.length) {
      layout = new Map(layout);
      for (const key of changed) {
        revisions.set(key, (revisions.get(key) ?? 0) + 1);
        layout.set(key, {
          ...layout.get(key)!,
          revision: String(revisions.get(key)),
        });
      }
    }
    animator.play(container, layout);
  }

  beforeEach(() => {
    motion.reduced = false;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' && motion.reduced,
    }));
    revisions = new Map();
    container = document.createElement('div');
    Object.defineProperties(container, {
      clientHeight: { value: 216 },
      // This unit fixture supplies virtual geometry rather than real overflow.
      scrollTop: { value: 0, writable: true },
    });
    document.body.append(container);
    animator = new FlipListAnimator();
    cancel = vi.fn();
    animate = vi.fn(
      (_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({
        cancel,
        onfinish: null,
      }),
    );
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });
  });

  afterEach(() => {
    animator.destroy();
    vi.unstubAllGlobals();
    container.remove();
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  });

  it('does not animate the initial load', () => {
    render(['pin', 'a', 'b']);
    play();
    expect(animate).not.toHaveBeenCalled();
  });

  it('slides and fades a new item below pins while displacing ordinary rows immediately', () => {
    render(['pin', 'a', 'b']);
    play();
    const [pin, incoming, displaced] = render(['pin', 'new', 'a', 'b']);
    play(['new']);
    expect(animate.mock.contexts).not.toContain(pin);
    expect(
      animate.mock.calls[animate.mock.contexts.indexOf(incoming)][0],
    ).toEqual([
      { opacity: 0, transform: 'translateX(-32px)' },
      { opacity: 1, transform: 'translateX(0)' },
    ]);
    expect(
      animate.mock.calls[animate.mock.contexts.indexOf(displaced)][0],
    ).toEqual([
      { transform: 'translateY(-72px)' },
      { transform: 'translateY(0)' },
    ]);
    for (const call of animate.mock.calls)
      expect(call[1]).not.toHaveProperty('delay');
  });

  it('slides a promoted row out of the old slot and into the new one', () => {
    render(['pin', 'a', 'b']);
    play();
    const [, incoming] = render(['pin', 'b', 'a']);
    play(['b']);
    const ghost = container.querySelector<HTMLElement>('[aria-hidden="true"]')!;
    expect(ghost.textContent).toBe('b');
    expect(ghost.style.top).toBe('144px');
    expect(ghost.hasAttribute('data-flip-key')).toBe(false);
    expect(ghost.inert).toBe(true);
    expect(animate.mock.calls[animate.mock.contexts.indexOf(ghost)][0]).toEqual(
      [
        { opacity: 1, transform: 'translateX(0)' },
        { opacity: 0, transform: 'translateX(32px)' },
      ],
    );
    expect(
      animate.mock.calls[animate.mock.contexts.indexOf(incoming)][0][0],
    ).toEqual({
      opacity: 0,
      transform: 'translateX(-32px)',
    });
    animator.destroy();
    expect(ghost.isConnected).toBe(false);
    expect(cancel).toHaveBeenCalled();
  });

  it('slides a removed row out while the remaining rows close its slot', () => {
    render(['pin', 'a', 'b']);
    play();
    render(['pin', 'b']);
    play();
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      'a',
    );
    expect(animate.mock.calls).toHaveLength(2);
  });

  it('cleans interrupted transitions and does not cancel them on unchanged renders', () => {
    render(['pin', 'a', 'b']);
    play();
    render(['pin', 'b', 'a']);
    play(['b']);
    const oldGhost = container.querySelector('[aria-hidden="true"]')!;
    play();
    expect(cancel).not.toHaveBeenCalled();
    render(['pin', 'a', 'b']);
    play(['a']);
    expect(oldGhost.isConnected).toBe(false);
    expect(cancel).toHaveBeenCalled();
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });

  it('uses the same transition for pinning and unpinning', () => {
    render(['pin', 'a', 'b']);
    play();
    render(['b', 'pin', 'a']);
    play(['b']);
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      'b',
    );
    render(['pin', 'a', 'b']);
    play(['b']);
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      'b',
    );
  });

  it('does not animate recycled rows when scrolling changes the mounted window', () => {
    const keys = Array.from({ length: 5000 }, (_, i) => String(i));
    render(keys, 0, 9);
    play();
    container.scrollTop = 100 * 72;
    mount(keys.slice(94, 109));
    play();
    expect(animate).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(container.querySelectorAll('[data-flip-key]')).toHaveLength(15);
  });

  it('slides in a promoted offscreen row, without inventing an offscreen exit', () => {
    render(['pin', 'a', 'b', 'c', 'far'], 0, 3);
    play();
    const [, incoming] = render(['pin', 'far', 'a', 'b', 'c'], 0, 3);
    play(['far']);
    expect(
      animate.mock.calls[animate.mock.contexts.indexOf(incoming)][0][0],
    ).toEqual({
      opacity: 0,
      transform: 'translateX(-32px)',
    });
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('preserves a visible exit when the target moves outside the window', () => {
    render(['pin', 'a', 'b', 'c', 'd'], 0, 3);
    play();
    render(['pin', 'a', 'c', 'd', 'b'], 0, 3);
    play(['b']);
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      'b',
    );
  });

  it('treats an existing row crossing the window boundary as displacement, not insertion', () => {
    render(['pin', 'a', 'b', 'c'], 1, 4);
    container.scrollTop = 72;
    play();
    const [, boundary] = render(['pin', 'c', 'a', 'b'], 1, 3);
    play(['c']);
    expect(
      animate.mock.calls[animate.mock.contexts.indexOf(boundary)][0],
    ).toEqual([
      { transform: 'translateY(-72px)' },
      { transform: 'translateY(0)' },
    ]);
  });

  it('cancels active animations on scrolling and respects reduced motion', () => {
    render(['pin', 'a', 'b']);
    play();
    render(['pin', 'b', 'a']);
    play(['b']);
    container.scrollTop = 72;
    play();
    expect(cancel).toHaveBeenCalled();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    animate.mockClear();
    motion.reduced = true;
    render(['pin', 'a', 'b']);
    play(['b']);
    expect(animate).not.toHaveBeenCalled();
  });
});
